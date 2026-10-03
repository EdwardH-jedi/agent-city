// Config validation and clamps (role 03, R-N3 / R-N7). Credentials are generated at runtime.
import { describe, expect, test } from "bun:test";
import { createWorkspaceAuth } from "./auth.ts";
import {
	exactOrigin,
	resolveWorkspaceAuthConfig,
	SESSION_TTL_MAX_MS,
} from "./config.ts";
import { newCredential, ORIGIN } from "./test-support.ts";

describe("config", () => {
	test("lifetimes are clamped: session ≤ 12 h, idle ≤ session, challenge ≤ 300 s, floors 1 s", () => {
		const r = resolveWorkspaceAuthConfig({
			operator_credential: newCredential(),
			allowed_origin: ORIGIN,
			session_ttl_ms: 48 * 3_600_000,
			idle_timeout_ms: 99 * 3_600_000,
			challenge_ttl_ms: 3_600_000,
			max_sessions_per_principal: 1000,
			max_body_bytes: 1e12,
		});
		if (!r.ok) throw new Error(r.reason);
		expect(r.config.session_ttl_ms).toBe(SESSION_TTL_MAX_MS);
		expect(r.config.idle_timeout_ms).toBe(SESSION_TTL_MAX_MS);
		expect(r.config.challenge_ttl_ms).toBe(300_000);
		expect(r.config.max_sessions_per_principal).toBe(16);
		expect(r.config.max_body_bytes).toBe(1024 * 1024);
		const low = resolveWorkspaceAuthConfig({
			operator_credential: newCredential(),
			allowed_origin: ORIGIN,
			session_ttl_ms: 5,
			idle_timeout_ms: -1,
			challenge_ttl_ms: 0,
			max_sessions_per_principal: 0,
		});
		if (!low.ok) throw new Error(low.reason);
		expect([
			low.config.session_ttl_ms,
			low.config.idle_timeout_ms,
			low.config.challenge_ttl_ms,
		]).toEqual([1000, 1000, 1000]);
		expect(low.config.max_sessions_per_principal).toBe(1);
		const nan = resolveWorkspaceAuthConfig({
			operator_credential: newCredential(),
			allowed_origin: ORIGIN,
			session_ttl_ms: Number.NaN,
			challenge_ttl_ms: Number.POSITIVE_INFINITY,
		});
		if (!nan.ok) throw new Error(nan.reason);
		expect(nan.config.session_ttl_ms).toBe(8 * 3_600_000);
		expect(nan.config.challenge_ttl_ms).toBe(300_000);
		expect(nan.config.idle_timeout_ms).toBe(30 * 60_000);
	});

	test("exact origin form only", () => {
		for (const ok of [
			"http://127.0.0.1:5173",
			"https://127.0.0.1:8443",
			"http://localhost",
		])
			expect(exactOrigin(ok)).toBe(ok);
		for (const bad of [
			"http://localhost:80",
			"http://127.0.0.1:5173/",
			"HTTP://127.0.0.1:5173",
			"http://u@h",
			"null",
			"file:///x",
			"",
			5,
		])
			expect(exactOrigin(bad)).toBeNull();
	});

	test("settings expose no credential; Secure follows the primary origin's scheme", () => {
		const cred = newCredential();
		const http = createWorkspaceAuth({
			operator_credential: cred,
			allowed_origin: ORIGIN,
		});
		expect(http.settings?.secure_cookie).toBe(false);
		expect(JSON.stringify(http.settings)).not.toContain(cred);
		expect(JSON.stringify(http)).not.toContain(cred);
		const https = createWorkspaceAuth({
			operator_credential: cred,
			allowed_origin: "https://127.0.0.1:8443",
		});
		expect(https.settings?.secure_cookie).toBe(true);
	});
});
