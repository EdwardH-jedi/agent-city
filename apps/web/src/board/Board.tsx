// The main screen (design doc §3): a status sentence, the HQ queue, the project village and what is
// running now. It only reads (useHub, GET + /ws) and draws; there is nothing to click and no way to act.
// `?demo=1` draws the same screen from made-up data instead (DemoBoard.tsx, a lazy chunk): no request,
// no sound, and the screen says "예시 데이터".
import { useEffect, useMemo, useRef, useState } from "react";
import { CampusView } from "../campus/CampusView.tsx";
import { machinesAt, runsAt } from "../merge.ts";
import { type Conn, type useHub, useRunEvents } from "../useHub.ts";
import { burnInShift } from "./burnin.ts";
import { DEMO_LABEL } from "./demo-flag.ts";
import { Hq } from "./Hq.tsx";
import { toVillageModel, type VillageModel } from "./model.ts";
import { Now } from "./Now.tsx";
import {
	isAudible,
	parseSoundPrefs,
	planSounds,
	play,
	type SoundMemory,
} from "./sound.ts";
import { currentRuns } from "./types.ts";
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

	// changes only this screen can see (a phase or a finish has no event time); kept across ticks
	const watchRef = useRef(emptyWatch());
	const watch = useMemo(() => {
		watchRef.current = stepWatch(watchRef.current, currentRuns(runs), now);
		return watchRef.current;
	}, [runs, now]);

	const model = useMemo(
		() =>
			toVillageModel({
				runs,
				machines,
				districts: hub.districts,
				eventsByRun,
				now,
				conn: hub.conn as Conn,
				watch,
			}),
		[runs, machines, hub.districts, eventsByRun, now, hub.conn, watch],
	);

	// sound: only while the Mac reports, the screen is connected, it is not quiet; never a pile afterwards
	const prefs = useMemo(() => parseSoundPrefs(window.location.search), []);
	const memory = useRef<SoundMemory | null>(null);
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
		);
		memory.current = plan.memory;
		for (const cue of plan.cues) play(cue);
	}, [model, now, prefs, loaded]);

	return (
		<BoardView
			model={model}
			now={now}
			reconnecting={hub.conn === "reconnecting"}
			error={hub.error}
			demo={false}
		/>
	);
}

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
}: {
	model: VillageModel;
	now: number;
	reconnecting: boolean;
	error: string | null;
	demo: boolean;
}) {
	return (
		<div className={`board border-${model.status.border}`}>
			<header
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
				<div className="board-counts">
					오늘 완료 <b>{model.today.completed}</b> · 진행{" "}
					<b>{model.today.running}</b>
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
				<Hq model={model} now={now} />
				<CampusView model={model} now={now} />
				<Now model={model} now={now} />
			</div>
			{error && <div className="board-error">{error}</div>}
		</div>
	);
}
