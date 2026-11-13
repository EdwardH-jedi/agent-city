// The main screen (design doc §3): a status sentence, the HQ queue, the project village and what is
// running now. It only reads (useHub, GET + /ws) and draws; there is nothing to click and no way to act.
// `?demo=1` draws the same screen from made-up data instead (DemoBoard.tsx, a lazy chunk): no request,
// no sound, and the screen says "예시 데이터".

import type { RunView, Session, UsageSummary } from "@agent-city/schema";
import {
	type CSSProperties,
	memo,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CampusView } from "../campus/CampusView.tsx";
import { machinesAt, runsAt } from "../merge.ts";
import { sceneOf } from "../town/params.ts";
import { TownMinimapSlot, TownView } from "../town/TownView.tsx";
import { type Conn, type useHub, useRunEvents } from "../useHub.ts";
import { burnInShift } from "./burnin.ts";
import { DEMO_LABEL } from "./demo-flag.ts";
import {
	type BurstMemory,
	type ChimeMemory,
	finishedToday,
	planChime,
	stepBursts,
} from "./done.ts";
import { Hq } from "./Hq.tsx";
import { type BoardColumns, boardColumns, uiScaleOf } from "./layout.ts";
import { toVillageModel, type VillageModel } from "./model.ts";
import { Sessions, WIDE_MIN } from "./Sessions.tsx";
import { parseSessionWait, recentSessions } from "./sessions.ts";
import {
	isAudible,
	parseSoundPrefs,
	planSounds,
	play,
	quietEndHour,
	type SoundMemory,
} from "./sound.ts";
import type { MemEvent } from "./tail-memory.ts";
import {
	clockText,
	dateText,
	hiddenAt,
	minuteKey,
	msToNextMinute,
	sessionsToday,
	TOP_FOLD,
} from "./today.ts";
import { currentRuns } from "./types.ts";
import { Usage } from "./Usage.tsx";
import { USAGE_TREND_MIN_BODY, usagePanel, usageTopWord } from "./usage.ts";
import { emptyWatch, stepWatch } from "./visits.ts";

export type HubData = ReturnType<typeof useHub>;

export function useClock(ms: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(t);
	}, [ms]);
	return now;
}

/** The column widths for the window (15 §1), recomputed when it is resized. */
function useBoardColumns(): BoardColumns {
	const [cols, setCols] = useState(() =>
		boardColumns(window.innerWidth, window.innerHeight),
	);
	useEffect(() => {
		const fit = () => {
			const next = boardColumns(window.innerWidth, window.innerHeight);
			setCols((c) =>
				c.left === next.left && c.top === next.top && c.body === next.body
					? c
					: next,
			);
		};
		window.addEventListener("resize", fit);
		return () => window.removeEventListener("resize", fit);
	}, []);
	return cols;
}

export function Board({ hub }: { hub: HubData }) {
	const now = useClock(1_000);
	const machines = useMemo(
		() => machinesAt(hub.machines, now),
		[hub.machines, now],
	);
	const runs = useMemo(
		() => runsAt(hub.runs, machines, now),
		[hub.runs, machines, now],
	);
	// events of the runs that count as current (one per project + workflow)
	const currentRaw = useMemo(
		() => currentRuns(hub.runs).map((c) => c.run),
		[hub.runs],
	);
	const eventsByRun = useRunEvents(currentRaw);

	// changes only this screen can see (a phase or a finish has no event time, when a condition or a
	// session's wait began); kept across ticks
	const watchRef = useRef(emptyWatch());
	const watch = useMemo(() => {
		watchRef.current = stepWatch(
			watchRef.current,
			currentRuns(runs),
			now,
			recentSessions(hub.sessions, now),
			machines,
		);
		return watchRef.current;
	}, [runs, hub.sessions, machines, now]);

	// `?session_wait=30` (minutes; 0 = no session visit): a URL query, no env variable
	const sessionWaitMs = useMemo(
		() => parseSessionWait(window.location.search),
		[],
	);
	const model = useMemo(
		() =>
			toVillageModel({
				runs,
				machines,
				districts: hub.districts,
				eventsByRun,
				sessions: hub.sessions,
				sessionWaitMs,
				now,
				conn: hub.conn as Conn,
				watch,
			}),
		[
			runs,
			machines,
			hub.districts,
			eventsByRun,
			hub.sessions,
			sessionWaitMs,
			now,
			hub.conn,
			watch,
		],
	);

	// sound: only while the Mac reports, the screen is connected, it is not quiet; never a pile afterwards
	const prefs = useMemo(() => parseSoundPrefs(window.location.search), []);
	const memory = useRef<SoundMemory | null>(null);
	const chimed = useRef<ChimeMemory | null>(null);
	const loaded = hub.machines.length > 0; // the first snapshot has arrived
	useEffect(() => {
		const cockpit =
			model.machines.find((m) => m.id === "cockpit")?.status ?? "unobserved";
		const audible =
			loaded &&
			isAudible({ prefs, date: new Date(now), cockpit, conn: model.conn });
		const plan = planSounds(
			loaded ? memory.current : null,
			model.marks,
			now,
			audible,
			quietEndHour(prefs),
		);
		memory.current = plan.memory;
		for (const cue of plan.cues) play(cue);
		// 17 §3: a new finish chimes once (over the soft tone planSounds already plays for it); a tick the
		// planner keeps silent (first look, settle window, not audible) only re-bases the chime's memory
		const chime = planChime(loaded ? chimed.current : null, model.visits, {
			prefs,
			date: new Date(now),
			cockpit,
			conn: model.conn,
			settled: now >= plan.memory.settleUntil,
		});
		chimed.current = chime.memory;
		if (chime.chime) play("chime");
	}, [model, now, prefs, loaded]);

	return (
		<BoardView
			model={model}
			now={now}
			reconnecting={hub.conn === "reconnecting"}
			error={hub.error}
			demo={false}
			sessions={hub.sessions}
			events={hub.events}
			runs={hub.runs}
			usage={hub.usage}
		/>
	);
}

/**
 * This device's local minute: changes only when the minute does (one timer, aligned to :00). Re-armed
 * when the page shows again (timers do not run while the device sleeps).
 */
function useMinute(): number {
	const [t, setT] = useState(() => Date.now());
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = () => {
			const n = Date.now();
			setT((cur) => (minuteKey(cur) === minuteKey(n) ? cur : n));
			clearTimeout(timer);
			timer = setTimeout(tick, msToNextMinute(Date.now()) + 20);
		};
		tick();
		document.addEventListener("visibilitychange", tick);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", tick);
		};
	}, []);
	return t;
}

/**
 * The top band's clock (17 §2): `10:47`, the sentence's size but weight 400 and the muted colour, then the
 * date at panel size. It is this device's fact: it keeps going while reports are cut. Redrawn only when
 * the minute changes (its own timer; the board's 1 s tick does not reach it).
 */
const TopClock = memo(function TopClock({ hideDate }: { hideDate: boolean }) {
	const t = useMinute();
	return (
		<div className="board-clock">
			<time className="board-time">{clockText(t)}</time>
			{!hideDate && <span className="board-date">{dateText(t)}</span>}
		</div>
	);
});

/**
 * The right panel's list height (px): the column under the top band less its padding (8 + 8), the panel
 * box's border (2), its head strip (style.css `.phead`: max(28 px, title + 9 px)) and the list's padding
 * (4 + 4), and 2 px of slack for rounding.
 */
const listBudget = (body: number, ui: number): number =>
	body - 16 - 2 - Math.max(28, 14 * ui + 9) - 8 - 2;

const MACHINE_WORD: Record<VillageModel["machines"][number]["status"], string> =
	{
		online: "켜짐",
		stale: "늦음",
		offline: "꺼짐",
		unobserved: "모름",
	};

export function BoardView({
	model,
	now,
	reconnecting,
	error,
	demo,
	sessions,
	events,
	runs,
	usage,
}: {
	model: VillageModel;
	now: number;
	reconnecting: boolean;
	error: string | null;
	demo: boolean;
	/** The right panel's sessions and their events (what useHub holds; nothing more is fetched). */
	sessions: readonly Session[];
	events: readonly MemEvent[];
	/** The runs useHub holds (the flags and confetti of 17 §3). */
	runs: readonly RunView[];
	/** Token usage from /ws (18 §5): the top band's `토큰` and the USAGE box. Null: neither is drawn. */
	usage: UsageSummary | null;
}) {
	// The ring town in the middle column (design doc 12, the default); `?scene=campus`: the 3D campus.
	const [scene] = useState(() => sceneOf(window.location.search));
	const town = scene === "town";
	const cols = useBoardColumns();
	// `?ui=1.15` / `?ui=1.3`: one scale for every panel text size (15 §1); not the sentence, not the columns
	const [ui] = useState(() => uiScaleOf(window.location.search));
	const frame = {
		"--col-l": `${cols.left}px`,
		"--col-r": `${cols.right}px`,
		"--top-h": `${cols.top}px`,
		"--ui": String(ui),
	} as CSSProperties;
	// 17 §3: today's finished buildings (flags) and the new finishes flying now (confetti)
	// recomputed when the minute changes (midnight takes the flags down) or useHub's runs do
	const minute = Math.floor(now / 60_000) * 60_000;
	const finished = useMemo(
		() => finishedToday(runs, minute + 59_999),
		[runs, minute],
	);
	// a burst, once seen, flies its 20 s even if a newer report of the project takes the door
	const burstMemory = useRef<BurstMemory>([]);
	burstMemory.current = stepBursts(burstMemory.current, model.visits, now);
	const bursts = model.status.dim ? [] : burstMemory.current;
	const burstKey = bursts.map((b) => `${b.project_id}|${b.at}`).join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new object only when what it says changes
	const done = useMemo(
		() => ({
			finished,
			bursts: bursts.map((b) => ({ repo_id: b.project_id, at: b.at })),
		}),
		[finished, burstKey],
	);
	const sessionCount = sessionsToday(sessions, now);
	// 18 §5 U3: `토큰` is today's whole usage (every session the collectors saw), not Office's run figures;
	// no usage today → no cell. Recomputed when the minute changes (Sydney midnight rolls it over).
	const usageNow = useMemo(() => usagePanel(usage, minute), [usage, minute]);
	// 17 §2: a band too narrow for one line hides the date, then the tokens, then the sessions. Measured
	// before paint; starts over when the window or the band's words change.
	const topRef = useRef<HTMLElement>(null);
	const [fold, setFold] = useState(0);
	const tokenWord = usageTopWord(usageNow);
	const sentence = model.status.sentence;
	const { completed, running } = model.today;
	// biome-ignore lint/correctness/useExhaustiveDependencies: these are the band's words; a change re-measures from 0
	useLayoutEffect(() => {
		setFold(0);
	}, [sentence, tokenWord, sessionCount, completed, running, demo]);
	// a wider (or narrower) window: measure again from nothing hidden
	useEffect(() => {
		const again = () => setFold(0);
		window.addEventListener("resize", again);
		return () => window.removeEventListener("resize", again);
	}, []);
	useLayoutEffect(() => {
		const el = topRef.current;
		if (!el || fold >= TOP_FOLD.length) return;
		if (el.scrollWidth > el.clientWidth + 1) setFold(fold + 1);
	});
	const hidden = hiddenAt(fold);
	return (
		<div
			className={`board border-${model.status.border}${town ? " scene-town" : ""}`}
			style={frame}
		>
			<header
				ref={topRef}
				className="board-top"
				style={{
					transform: `translate(${burnInShift(now).x}px, ${burnInShift(now).y}px)`,
				}}
			>
				<div className="board-sentence">{model.status.sentence}</div>
				<ul className="board-machines" aria-label="머신">
					{model.machines.map((m) => (
						<li key={m.id} className={`bm bm-${m.status}`}>
							<i className="bm-dot" aria-hidden="true" />
							{m.id} {MACHINE_WORD[m.status]}
						</li>
					))}
				</ul>
				<TopClock hideDate={hidden.has("date")} />
				<div
					className={`board-counts${model.status.dim ? " counts-still" : ""}`}
				>
					오늘 완료 <b>{model.today.completed}</b> · 진행{" "}
					<b>{model.today.running}</b>
					{!hidden.has("sessions") && (
						<span className="count-sessions">
							· 세션 <b>{sessionCount}</b>
						</span>
					)}
					{tokenWord && !hidden.has("tokens") && (
						<span className="count-tokens">
							· 토큰 <b>{tokenWord}</b>
						</span>
					)}
				</div>
				{demo ? (
					<span className="demo-band">{DEMO_LABEL}</span>
				) : (
					<a className="board-link" href="#/detail">
						상세 (D)
					</a>
				)}
			</header>
			{reconnecting && <div className="conn-band">화면 연결 끊김</div>}
			<div className="board-body">
				<Hq
					model={model}
					now={now}
					top={town ? <TownMinimapSlot /> : null}
					bottom={
						<Usage
							panel={usageNow}
							pixel={town}
							trend={cols.body >= USAGE_TREND_MIN_BODY}
						/>
					}
					pixel={town}
				/>
				{town ? (
					<TownView
						model={model}
						now={now}
						sessions={sessions}
						events={events}
						done={done}
					/>
				) : (
					<CampusView model={model} now={now} />
				)}
				<Sessions
					model={model}
					sessions={sessions}
					events={events}
					now={now}
					budget={listBudget(cols.body, ui)}
					ui={ui}
					wide={cols.left + cols.middle + cols.right >= WIDE_MIN}
					pixel={town}
				/>
			</div>
			{error && <div className="board-error">{error}</div>}
		</div>
	);
}
