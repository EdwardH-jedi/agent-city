// In-memory operator sessions (role 03). Nothing here is persisted: a hub restart mints a new
// boot id and forgets every session, which also voids every outstanding challenge (challenges bind
// boot_id + session_generation). The cookie value is an opaque 256-bit random token; only its sha256
// is kept as the map key. The CSRF token is kept in memory (it must be returned by GET /session) and
// compared through digests in constant time.
import { timingSafeEqual } from "node:crypto";
import {
	type BootId,
	OPERATOR_ID,
	OperatorPrincipal,
	type OperatorScope,
	Token256,
} from "@agent-city/schema/workspace-m1";
import { newBootId, newToken256 } from "@agent-city/schema/workspace-m1/hash";
import { digestSecret, type PrincipalKey } from "./config.ts";

export interface SessionRecord {
	/** hex sha256 of the cookie value (map key). */
	readonly id_hash: string;
	readonly principal_key: PrincipalKey;
	/** Frozen; derived from the server-side session only, never from a request body. */
	readonly principal: OperatorPrincipal;
	readonly csrf_token: string;
	readonly created_ms: number;
	/** Absolute end of life. */
	readonly expires_ms: number;
	last_seen_ms: number;
}

export interface SessionLimits {
	session_ttl_ms: number;
	idle_timeout_ms: number;
	max_sessions_per_principal: number;
}

const idHash = (cookieValue: string) =>
	digestSecret(cookieValue).toString("hex");

/** Constant-time equality of a presented secret and a known one (sha256 first → equal lengths). */
export const secretMatches = (given: string, expected: string): boolean =>
	timingSafeEqual(digestSecret(given), digestSecret(expected));

export class SessionStore {
	/** Hub process generation; bound into every principal and challenge of this boot. */
	readonly boot_id: BootId = newBootId();
	#generation = 0;
	readonly #sessions = new Map<string, SessionRecord>();
	readonly #limits: SessionLimits;

	constructor(limits: SessionLimits) {
		this.#limits = limits;
	}

	get size(): number {
		return this.#sessions.size;
	}

	/**
	 * New session for a principal whose credential was just verified. Rotation: the session named by
	 * the cookie presented with the sign-in (if any) is revoked; the new cookie value is always fresh
	 * (a chosen/fixated value can never become valid). Beyond the per-principal cap the oldest
	 * sessions of that principal are evicted. Every sign-in gets a new session_generation.
	 */
	create(
		principal_key: PrincipalKey,
		scopes: readonly OperatorScope[],
		presentedCookie: string | null,
		now_ms: number,
	): { cookie_value: string; record: SessionRecord } {
		this.#purge(now_ms);
		if (presentedCookie !== null)
			this.#sessions.delete(idHash(presentedCookie));
		const mine = [...this.#sessions.values()]
			.filter((s) => s.principal_key === principal_key)
			.sort((a, b) => a.created_ms - b.created_ms);
		const excess = mine.length - (this.#limits.max_sessions_per_principal - 1);
		for (const old of mine.slice(0, Math.max(0, excess)))
			this.#sessions.delete(old.id_hash);

		this.#generation += 1;
		const principal = OperatorPrincipal.parse({
			operator_id: OPERATOR_ID,
			scopes: [...scopes],
			session_generation: this.#generation,
			boot_id: this.boot_id,
		});
		Object.freeze(principal.scopes);
		Object.freeze(principal);
		const cookie_value = newToken256();
		const record: SessionRecord = {
			id_hash: idHash(cookie_value),
			principal_key,
			principal,
			csrf_token: newToken256(),
			created_ms: now_ms,
			expires_ms: now_ms + this.#limits.session_ttl_ms,
			last_seen_ms: now_ms,
		};
		this.#sessions.set(record.id_hash, record);
		return { cookie_value, record };
	}

	/** The live session named by a cookie value, or null (unknown, malformed, expired or idle). */
	lookup(cookieValue: string, now_ms: number): SessionRecord | null {
		if (!Token256.safeParse(cookieValue).success) return null;
		const record = this.#sessions.get(idHash(cookieValue));
		if (!record) return null;
		if (!this.#alive(record, now_ms)) {
			this.#sessions.delete(record.id_hash);
			return null;
		}
		return record;
	}

	/** Still stored and not expired at `now_ms` (used by the challenge port inside a transaction). */
	isLive(record: SessionRecord, now_ms: number): boolean {
		return (
			this.#sessions.get(record.id_hash) === record &&
			this.#alive(record, now_ms)
		);
	}

	/** Refresh the idle clock (only after a request passed every check). */
	touch(record: SessionRecord, now_ms: number): void {
		if (now_ms > record.last_seen_ms) record.last_seen_ms = now_ms;
	}

	csrfMatches(record: SessionRecord, presented: string): boolean {
		return secretMatches(presented, record.csrf_token);
	}

	/** When the session ends if it sees no further activity. */
	expiresAtMs(record: SessionRecord): number {
		return Math.min(
			record.expires_ms,
			record.last_seen_ms + this.#limits.idle_timeout_ms,
		);
	}

	revoke(record: SessionRecord): void {
		if (this.#sessions.get(record.id_hash) === record)
			this.#sessions.delete(record.id_hash);
	}

	/** Server-side revocation of every session (harness: BRW-R-28). */
	revokeAll(): void {
		this.#sessions.clear();
	}

	#alive(record: SessionRecord, now_ms: number): boolean {
		return (
			now_ms < record.expires_ms &&
			now_ms - record.last_seen_ms < this.#limits.idle_timeout_ms
		);
	}

	#purge(now_ms: number): void {
		for (const r of [...this.#sessions.values()])
			if (!this.#alive(r, now_ms)) this.#sessions.delete(r.id_hash);
	}
}
