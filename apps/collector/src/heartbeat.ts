// Machine heartbeat sender: `bun run collector:heartbeat`. Every 30 s it POSTs one tiny "this machine
// is running" beat to the hub (/ingest/heartbeat) so the city can show cockpit / spine / forge as
// online, stale or offline. It reports a machine fact, never whether any AI work succeeded.
//
// The beat carries no path, command or prompt (the hub's schema has no field for one). A failed send
// is dropped, not queued: an old heartbeat means nothing. The sender never throws and never prints
// the token or the body.
import { randomUUID } from "node:crypto";
import {
	HEARTBEAT_INTERVAL_S,
	type Heartbeat,
	MachineRole,
} from "@agent-city/schema";
import { type CollectorConfig, loadConfig } from "./config.ts";

const SEND_TIMEOUT_MS = 5_000;
const HOSTNAME_MAX = 64;

/** Why the sender cannot start, or null when the config is usable. Never includes the token. */
export function heartbeatConfigError(cfg: CollectorConfig): string | null {
	if (!MachineRole.safeParse(cfg.machine).success) {
		return `AGENTCITY_MACHINE must be one of ${MachineRole.options.join(", ")}`;
	}
	if (!cfg.ingestToken) return "INGEST_TOKEN is not set (see .env.example)";
	return null;
}

export interface SenderOptions {
	fetchImpl?: typeof fetch;
	now?: () => Date;
	/** One per process start; a new value tells the hub this machine restarted. */
	bootId?: string;
	intervalS?: number;
}

export interface Sender {
	/** The next heartbeat body; every call consumes a sequence number. */
	build(): Heartbeat;
	/** POST one beat. true only when the hub accepted the request; never throws. */
	send(): Promise<boolean>;
}

export function createSender(
	cfg: CollectorConfig,
	opts: SenderOptions = {},
): Sender {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const now = opts.now ?? (() => new Date());
	const bootId = opts.bootId ?? randomUUID();
	const intervalS = opts.intervalS ?? HEARTBEAT_INTERVAL_S;
	const host = cfg.hostname.slice(0, HOSTNAME_MAX);
	let seq = 0;

	const build = (): Heartbeat => ({
		schema: 1,
		machine_id: MachineRole.parse(cfg.machine),
		...(host ? { hostname: host } : {}),
		boot_id: bootId,
		seq: seq++,
		sent_at: now().toISOString(),
		interval_s: intervalS,
	});

	const send = async (): Promise<boolean> => {
		try {
			const res = await fetchImpl(`${cfg.hubUrl}/ingest/heartbeat`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${cfg.ingestToken ?? ""}`,
				},
				body: JSON.stringify(build()),
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
			});
			return res.ok;
		} catch {
			return false;
		}
	};

	return { build, send };
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

const defaultSleep: Sleep = (ms, signal) =>
	new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true },
		);
	});

/** Beat, wait, repeat until aborted. `onResult` sees each outcome (used to log only changes). */
export async function runHeartbeatLoop(opts: {
	send: () => Promise<boolean>;
	intervalMs: number;
	signal: AbortSignal;
	sleep?: Sleep;
	onResult?: (ok: boolean) => void;
}): Promise<void> {
	const sleep = opts.sleep ?? defaultSleep;
	while (!opts.signal.aborted) {
		opts.onResult?.(await opts.send());
		if (opts.signal.aborted) break;
		await sleep(opts.intervalMs, opts.signal);
	}
}

if (import.meta.main) {
	const cfg = loadConfig();
	const problem = heartbeatConfigError(cfg);
	if (problem) {
		console.error(`heartbeat: ${problem}`);
		process.exit(1);
	}
	const sender = createSender(cfg);
	const stop = new AbortController();
	for (const sig of ["SIGINT", "SIGTERM"] as const) {
		process.on(sig, () => stop.abort());
	}
	console.log(
		`heartbeat: machine=${cfg.machine} hub=${cfg.hubUrl} every ${HEARTBEAT_INTERVAL_S}s`,
	);
	let last: boolean | null = null;
	await runHeartbeatLoop({
		send: sender.send,
		intervalMs: HEARTBEAT_INTERVAL_S * 1000,
		signal: stop.signal,
		// Say something only when the state changes, so a hub that is down does not flood the log.
		onResult: (ok) => {
			if (ok !== last) {
				console.log(
					`heartbeat: ${ok ? "hub accepted the beat" : "hub unreachable or refused; dropping beats until it recovers"}`,
				);
				last = ok;
			}
		},
	});
}
