// Sound (design doc §5, §7): synthesised with Web Audio, no audio files. What may sound is decided by
// pure functions (planSounds / isAudible) so it can be tested; play() is the only side effect.
// No env variable: the quiet hours and the on/off switch come from the page URL (?quiet=23-8, ?sound=off).
import type { MachineView } from "@agent-city/schema";

export type Cue = "knock" | "low" | "soft";

export const REMIND_MS = 30 * 60_000;

export interface SoundPrefs {
	enabled: boolean;
	/** Local hours [from, to); from > to wraps midnight. null = never quiet. */
	quiet: { from: number; to: number } | null;
}

const DEFAULT_QUIET = { from: 23, to: 8 } as const;

/** `?sound=off` mutes; `?quiet=22-7` sets the hours; `?quiet=off` removes them. Anything unparseable keeps the default. */
export function parseSoundPrefs(search: string): SoundPrefs {
	const q = new URLSearchParams(search);
	const enabled = q.get("sound") !== "off";
	const raw = q.get("quiet");
	if (raw === "off") return { enabled, quiet: null };
	const m = raw ? /^(\d{1,2})-(\d{1,2})$/.exec(raw) : null;
	const from = m ? Number(m[1]) : Number.NaN;
	const to = m ? Number(m[2]) : Number.NaN;
	const ok = from >= 0 && from <= 24 && to >= 0 && to <= 24 && from !== to;
	return { enabled, quiet: ok ? { from, to } : { ...DEFAULT_QUIET } };
}

/** Is `date`'s local hour inside the quiet hours? 23-8 covers 23:00 through 07:59. */
export function isQuiet(prefs: SoundPrefs, date: Date): boolean {
	if (!prefs.quiet) return false;
	const { from, to } = prefs.quiet;
	const h = date.getHours() + date.getMinutes() / 60;
	return from < to ? h >= from && h < to : h >= from || h < to;
}

/** Sound only while the Mac is reporting, the screen is connected, it is not quiet, and sound is on. */
export function isAudible(ctx: {
	prefs: SoundPrefs;
	date: Date;
	cockpit: MachineView["status"];
	conn: "open" | "reconnecting";
}): boolean {
	return (
		ctx.prefs.enabled &&
		ctx.cockpit === "online" &&
		ctx.conn === "open" &&
		!isQuiet(ctx.prefs, ctx.date)
	);
}

export interface SoundMemory {
	waiting: readonly string[];
	stopped: readonly string[];
	passed: readonly string[];
	lastKnockAt: number;
	/** Until this time only the memory is refreshed: a snapshot may still be on its way. */
	settleUntil: number;
}

/** After the screen may sound again (first load, reconnect, Mac back), wait for the snapshot to land. */
export const SETTLE_MS = 5_000;

export interface Marks {
	waiting: readonly string[];
	stopped: readonly string[];
	passed: readonly string[];
}

/**
 * What to play for the change since `prev`. The first look, and any tick that may not sound, only
 * re-bases the memory: what happened while silent is never played afterwards in a pile (§7).
 * A 결재 that is still open knocks once more every 30 minutes.
 */
export function planSounds(
	prev: SoundMemory | null,
	marks: Marks,
	now: number,
	audible: boolean,
): { memory: SoundMemory; cues: Cue[] } {
	if (!prev || !audible) {
		return {
			memory: { ...marks, lastKnockAt: now, settleUntil: now + SETTLE_MS },
			cues: [],
		};
	}
	if (now < prev.settleUntil) {
		return {
			memory: { ...marks, lastKnockAt: now, settleUntil: prev.settleUntil },
			cues: [],
		};
	}
	const fresh = (now_: readonly string[], was: readonly string[]) =>
		now_.some((k) => !was.includes(k));
	const cues: Cue[] = [];
	if (fresh(marks.stopped, prev.stopped)) cues.push("low");
	let lastKnockAt = prev.lastKnockAt;
	if (
		fresh(marks.waiting, prev.waiting) ||
		(marks.waiting.length > 0 && now - prev.lastKnockAt >= REMIND_MS)
	) {
		cues.push("knock");
		lastKnockAt = now;
	}
	if (fresh(marks.passed, prev.passed)) cues.push("soft");
	return { memory: { ...marks, lastKnockAt }, cues };
}

let ctx: AudioContext | null = null;

function tone(
	c: AudioContext,
	at: number,
	hz: number,
	len: number,
	gain: number,
) {
	const osc = c.createOscillator();
	const g = c.createGain();
	osc.type = "sine";
	osc.frequency.value = hz;
	g.gain.setValueAtTime(0.0001, at);
	g.gain.exponentialRampToValueAtTime(gain, at + 0.015);
	g.gain.exponentialRampToValueAtTime(0.0001, at + len);
	osc.connect(g).connect(c.destination);
	osc.start(at);
	osc.stop(at + len + 0.05);
}

/** Play one cue. The browser may refuse without a user gesture; that is swallowed (doc §5, §10 V3). */
export function play(cue: Cue): void {
	try {
		ctx ??= new AudioContext();
		const c = ctx;
		void c.resume();
		const t = c.currentTime;
		if (cue === "knock") {
			tone(c, t, 190, 0.12, 0.5);
			tone(c, t + 0.2, 190, 0.12, 0.5);
		} else if (cue === "low") {
			tone(c, t, 110, 0.9, 0.45);
		} else {
			tone(c, t, 523, 1.1, 0.25);
		}
	} catch {
		// no audio device, or autoplay blocked: the screen is still correct without it
	}
}
