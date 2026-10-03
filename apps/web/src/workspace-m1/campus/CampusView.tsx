// Campus (business-campus presentation, frozen interface agentcity.campus-presentation/v1).
// DOM first: the building buttons, the Headquarters button and the list of documents waiting at
// Headquarters are plain buttons that work with or without the 3D view. The WebGL scene is fetched
// lazily behind them, only when a WebGL context can be created; if it is missing, fails to start
// or loses its context, the DOM layer stays and a short neutral note says so.
//
// Authority: this view emits exactly three intents (select a repository, select a task, open an
// approval document). The scene receives a frozen object with those three methods and nothing
// else. Nothing here approves, queues, advances, cancels or accepts work.
import {
	Component,
	type KeyboardEvent,
	lazy,
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	onReducedMotionChange,
	prefersReducedMotion,
	webglAvailable,
} from "./environment.ts";
import { hqRequest, narrowActions } from "./intents.ts";
import { campusLayout } from "./layout.ts";
import type {
	CampusActions,
	CampusModel,
	CampusPendingRequest,
	CampusRepo,
} from "./presentation.ts";
import "./campus.css";

const CampusScene = lazy(() => import("./CampusScene.tsx"));

type SceneState = "probing" | "loading" | "live" | "paused" | "unavailable";
type Reason = "no_webgl" | "init_failed" | "context_lost";

const NOTE: Record<Reason, string> = {
	no_webgl:
		"3D view unavailable in this browser. Buildings and documents stay available here.",
	init_failed:
		"3D view could not start. Buildings and documents stay available here.",
	context_lost:
		"3D view paused: the graphics context was lost. Buildings and documents stay available here.",
};

export interface CampusViewProps {
	model: CampusModel;
	actions: CampusActions;
}

class SceneBoundary extends Component<
	{ onError: () => void; children: ReactNode },
	{ failed: boolean }
> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override componentDidCatch() {
		this.props.onError();
	}
	override render() {
		return this.state.failed ? null : this.props.children;
	}
}

function useReducedMotion(): boolean {
	const [reduced, setReduced] = useState(prefersReducedMotion);
	useEffect(() => onReducedMotionChange(setReduced), []);
	return reduced;
}

const plural = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

// `active_tasks` counts queued, running and cancel-requested work: "in progress", not "running" (with
// several repositories a queued execution may be waiting behind another repository's run)
function repoStats(r: CampusRepo): string {
	return `${r.active_tasks} in progress · ${r.pending_requests} awaiting decision`;
}

function GateGlyph({ kind }: { kind: CampusPendingRequest["kind"] }) {
	return kind === "run" ? (
		<svg viewBox="0 0 16 16" aria-hidden="true" className="cmp-glyph">
			<circle cx="8" cy="8" r="5.6" />
			<circle cx="8" cy="8" r="1.9" className="cmp-glyph-fill" />
		</svg>
	) : (
		<svg viewBox="0 0 16 16" aria-hidden="true" className="cmp-glyph">
			<path d="M4 2.5h5.5L12 5v8.5H4z" />
			<path d="M6 8h4M6 10.5h4" />
		</svg>
	);
}

function WarningGlyph() {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" className="cmp-glyph">
			<path d="M8 2.2 14.2 13H1.8z" />
			<path d="M8 6.4v3.2M8 11.1v.2" />
		</svg>
	);
}

function HqGlyph() {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" className="cmp-glyph">
			<path d="M2.5 13.5V4h11v9.5M1.5 13.5h13M5.5 6.5h1.5m2 0h1.5M5.5 9h1.5m2 0h1.5M7 13.5v-2h2v2" />
		</svg>
	);
}

export function CampusView({ model, actions }: CampusViewProps) {
	const uid = useId();
	const reduced = useReducedMotion();
	const [scene, setScene] = useState<SceneState>("probing");
	const [reason, setReason] = useState<Reason | null>(null);
	const [attempt, setAttempt] = useState(0);
	// height of the building buttons floating over the stage (the scene frames above them)
	const strip = useRef<HTMLUListElement>(null);
	const [inset, setInset] = useState(56);
	useEffect(() => {
		const el = strip.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() =>
			setInset(Math.ceil(el.offsetHeight) + 8),
		);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// One tab stop for the whole document strip (WAI-ARIA toolbar): Tab reaches the last focused,
	// selected or first document; the arrow keys, Home and End move between documents.
	const [rovingId, setRovingId] = useState<string | null>(null);
	const visitButtons = useRef(new Map<string, HTMLButtonElement>());

	// The scene only ever sees this frozen, three-method object (stable across renders).
	const latest = useRef(actions);
	useLayoutEffect(() => {
		latest.current = actions;
	});
	const safe = useMemo(
		() =>
			narrowActions({
				selectRepo: (id) => latest.current.selectRepo(id),
				selectTask: (id) => latest.current.selectTask(id),
				openRequest: (id) => latest.current.openRequest(id),
			}),
		[],
	);

	useEffect(() => {
		if (webglAvailable()) setScene("loading");
		else {
			setReason("no_webgl");
			setScene("unavailable");
		}
	}, []);

	const onUnavailable = useCallback((r: Reason) => {
		setReason(r);
		setScene(r === "context_lost" ? "paused" : "unavailable");
	}, []);
	const onReady = useCallback(() => {
		setScene((s) => (s === "loading" ? "live" : s));
	}, []);
	const onRestored = useCallback(() => {
		setReason(null);
		setScene("live");
	}, []);
	const onBoundaryError = useCallback(
		() => onUnavailable("init_failed"),
		[onUnavailable],
	);
	const restart = () => {
		setReason(null);
		setScene("loading");
		setAttempt((a) => a + 1);
	};

	const repoKey = model.repos.map((r) => r.repo_id).join("\n");
	const accents = useMemo(() => {
		const map = new Map<string, string>();
		for (const s of campusLayout(repoKey ? repoKey.split("\n") : []).slots)
			map.set(s.repo_id, s.accent);
		return map;
	}, [repoKey]);
	const labelOf = useMemo(() => {
		const map = new Map(model.repos.map((r) => [r.repo_id, r.label]));
		return (id: string) => map.get(id) ?? id;
	}, [model.repos]);

	const stage = scene !== "unavailable";
	const pending = model.pending;
	const target = hqRequest(model);
	const tabStop =
		pending.find((p) => p.request_id === rovingId)?.request_id ??
		pending.find((p) => p.selected)?.request_id ??
		pending[0]?.request_id ??
		null;
	const onVisitKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
		const n = pending.length;
		const next =
			e.key === "ArrowRight" || e.key === "ArrowDown"
				? (i + 1) % n
				: e.key === "ArrowLeft" || e.key === "ArrowUp"
					? (i - 1 + n) % n
					: e.key === "Home"
						? 0
						: e.key === "End"
							? n - 1
							: -1;
		const id = next < 0 ? undefined : pending[next]?.request_id;
		if (!id) return;
		e.preventDefault();
		setRovingId(id);
		visitButtons.current.get(id)?.focus();
	};
	const repoCount = plural(model.repos.length, "repository", "repositories");

	return (
		<section
			className="cmp"
			aria-labelledby={`${uid}-title`}
			data-scene-state={scene}
			data-reduced-motion={reduced ? "true" : "false"}
			data-mode={stage ? "stage" : "static"}
		>
			<div className="cmp-head">
				<h2 id={`${uid}-title`}>Campus</h2>
				<span className="cmp-sub">{repoCount} · Headquarters</span>
				{stage ? (
					<span className="cmp-caption">
						{scene === "live" || scene === "paused"
							? `Illustration only; decisions are made in the Headquarters document${reduced ? " · reduced motion" : ""}`
							: "Loading the 3D view…"}
					</span>
				) : null}
			</div>
			<div className="cmp-hq">
				<button
					type="button"
					className="cmp-hq-button"
					aria-label="Headquarters"
					aria-describedby={`${uid}-hq`}
					disabled={target === null}
					onClick={() => {
						if (target) safe.openRequest(target);
					}}
				>
					<HqGlyph />
					<span className="cmp-hq-name">Headquarters</span>
					<span id={`${uid}-hq`} className="cmp-hq-count">
						{pending.length === 0
							? "Nothing waiting"
							: `${plural(pending.length, "document", "documents")} waiting`}
					</span>
				</button>
				{pending.length > 0 ? (
					<ul
						className="cmp-visits"
						role="toolbar"
						aria-label="Documents waiting at Headquarters"
					>
						{pending.map((p, i) => {
							const title = p.title || "Untitled task";
							return (
								<li key={p.request_id} role="none">
									<button
										ref={(el) => {
											if (el) visitButtons.current.set(p.request_id, el);
											else visitButtons.current.delete(p.request_id);
										}}
										type="button"
										tabIndex={p.request_id === tabStop ? 0 : -1}
										onFocus={() => setRovingId(p.request_id)}
										onKeyDown={(e) => onVisitKey(e, i)}
										className="cmp-visit"
										data-request-id={p.request_id}
										data-gate={p.kind}
										aria-label={`${p.gate_label} · ${title}`}
										aria-describedby={`${uid}-v${i}`}
										aria-current={p.selected ? "true" : undefined}
										title={`${p.gate_label} · ${title}`}
										onClick={() => safe.openRequest(p.request_id)}
									>
										<GateGlyph kind={p.kind} />
										<span className="cmp-visit-gate">{p.gate_label}</span>
										<span id={`${uid}-v${i}`} className="cmp-visit-repo">
											{p.repo_id ? labelOf(p.repo_id) : "Unknown repository"}
										</span>
										<span className="cmp-visit-title">{title}</span>
									</button>
								</li>
							);
						})}
					</ul>
				) : null}
			</div>
			<div className="cmp-body">
				{stage ? (
					<div className="cmp-stage">
						{scene !== "probing" ? (
							<SceneBoundary key={attempt} onError={onBoundaryError}>
								<Suspense fallback={null}>
									<CampusScene
										model={model}
										actions={safe}
										reducedMotion={reduced}
										onUnavailable={onUnavailable}
										onReady={onReady}
										onRestored={onRestored}
										bottomInset={inset}
									/>
								</Suspense>
							</SceneBoundary>
						) : null}
					</div>
				) : null}
				{reason ? (
					<div className="cmp-note" role="status" data-reason={reason}>
						<p>{NOTE[reason]}</p>
						{reason === "context_lost" ? (
							<button type="button" className="cmp-restart" onClick={restart}>
								Restart 3D view
							</button>
						) : null}
					</div>
				) : null}
				<ul ref={strip} className="cmp-buildings" aria-label="Buildings">
					{model.repos.map((r, i) => (
						<li key={r.repo_id}>
							<button
								type="button"
								className="cmp-building"
								data-repo-id={r.repo_id}
								data-integrity={
									r.has_invalid_acceptance ? "invalid" : undefined
								}
								aria-label={r.repo_id}
								aria-describedby={`${uid}-b${i}${r.has_invalid_acceptance ? ` ${uid}-w${i}` : ""}`}
								aria-current={r.selected ? "true" : undefined}
								onClick={() => safe.selectRepo(r.repo_id)}
							>
								<span
									className="cmp-swatch"
									aria-hidden="true"
									style={{ background: accents.get(r.repo_id) }}
								/>
								<span className="cmp-building-name">{r.label}</span>
								<span id={`${uid}-b${i}`} className="cmp-building-stats">
									{repoStats(r)}
								</span>
								{r.has_invalid_acceptance ? (
									<span id={`${uid}-w${i}`} className="cmp-badge">
										<WarningGlyph />
										Integrity warning
									</span>
								) : null}
							</button>
						</li>
					))}
					{model.repos.length === 0 ? (
						<li className="cmp-empty">No repository is allowlisted.</li>
					) : null}
				</ul>
			</div>
		</section>
	);
}
