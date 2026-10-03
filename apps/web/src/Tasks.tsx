// Managed tasks: create a bounded task for an allowed repo, approve it to run, watch the attempt,
// inspect evidence and review findings. Talks to /api/managed with a bearer token the user pastes
// (kept in sessionStorage for this tab only). Everything shown is re-fetched from the hub, so a
// refresh or a reconnect loses nothing.
//
// Response ordering (v0.1.1): every request is tagged with the auth epoch (bumped on token change,
// Forget and 401) and, for detail / list / artifact loads, a sequence number. A response whose
// epoch or sequence is no longer current is dropped, and a task snapshot with a lower `rev` never
// replaces a newer one. A late 401 for an old token cannot clear a newer token.
import type {
	ExecutionMode,
	ManagedArtifact,
	ManagedReview,
	ManagedRun,
	ManagedTask,
	SimulationScenario,
} from "@agent-city/schema";
import {
	type FormEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type Badge,
	blockingReason,
	canCancel,
	canRun,
	diagnose,
	type Integrity,
	isActive,
	modeBadge,
	modelLabel,
	newerTask,
	runLabel,
	type Submission,
	sameSubmission,
	shortSha,
	splitLines,
	splitList,
	stateBadge,
} from "./managed-view.ts";

// ── API client ───────────────────────────────────────────────────────────────

interface ManagedInfo {
	repos: { id: string; base_ref: string; verification: string[] }[];
	live: {
		enabled: boolean;
		implementer: string | null;
		reviewer: string | null;
	};
	repair_limit: { default: number; max: number };
	scenarios: SimulationScenario[];
	live_integration_verified: boolean;
}

interface Detail {
	task: ManagedTask;
	runs: ManagedRun[];
	reviews: ManagedReview[];
	artifacts: ManagedArtifact[];
	integrity: Integrity | null;
	evidence_integrity?: { intact: boolean; problems: string[] } | null;
	quarantine?: { pid: number; reason: string; last_check: string | null }[];
}

class ApiError extends Error {
	constructor(
		/** 0 = no response at all (network error): the outcome of a write is unknown. */
		readonly status: number,
		readonly code: string | null,
		message: string,
	) {
		super(message);
	}
}

async function api<T>(token: string, path: string, json?: unknown): Promise<T> {
	let res: Response;
	try {
		res = await fetch(`/api/managed${path}`, {
			method: json === undefined ? "GET" : "POST",
			headers: {
				authorization: `Bearer ${token}`,
				...(json === undefined ? {} : { "content-type": "application/json" }),
			},
			body: json === undefined ? undefined : JSON.stringify(json),
		});
	} catch {
		throw new ApiError(0, null, "the hub could not be reached");
	}
	const data = (await res.json().catch(() => ({}))) as {
		error?: string;
		message?: string;
		reason?: string;
		issues?: { path: string; message: string }[];
	};
	if (!res.ok) {
		const issues = data.issues
			?.map((i) => `${i.path || "(body)"}: ${i.message}`)
			.join("; ");
		throw new ApiError(
			res.status,
			data.error ?? null,
			issues ||
				data.message ||
				data.reason ||
				data.error ||
				`HTTP ${res.status}`,
		);
	}
	return data as T;
}

/** A write whose outcome we cannot know: no response, or a server/proxy failure. */
const uncertain = (err: unknown) =>
	err instanceof ApiError && (err.status === 0 || err.status >= 500);

const TOKEN_KEY = "agentcity.managedToken";

const TASK_HASH = /^#tasks\/(task-[0-9a-f-]{36})$/;
/** `#tasks/<task id>` → the id; anything else → null. */
const taskFromHash = (): string | null =>
	TASK_HASH.exec(location.hash)?.[1] ?? null;
/** Keep the URL pointing at the selected task (no history entry per click). */
const setTaskHash = (id: string | null) =>
	history.replaceState(null, "", id ? `#tasks/${id}` : "#tasks");
const newKey = () => `ui-${crypto.randomUUID()}`;
type Call = <T>(path: string, json?: unknown) => Promise<T | undefined>;

// ── view ─────────────────────────────────────────────────────────────────────

function Tag({ badge }: { badge: Badge }) {
	return <span className={`mtag mtag-${badge.tone}`}>{badge.text}</span>;
}

export function Tasks({ managedSeq }: { managedSeq: number }) {
	const [token, setToken] = useState(
		() => sessionStorage.getItem(TOKEN_KEY) ?? "",
	);
	const [auth, setAuth] = useState<"none" | "authenticating" | "ok">(() =>
		sessionStorage.getItem(TOKEN_KEY) ? "authenticating" : "none",
	);
	const [draftToken, setDraftToken] = useState("");
	const [info, setInfo] = useState<ManagedInfo | null>(null);
	const [tasks, setTasks] = useState<ManagedTask[]>([]);
	// deep link: #tasks/<task id> selects that task (and survives a refresh)
	const [selected, setSelected] = useState<string | null>(() => taskFromHash());
	const [detail, setDetail] = useState<Detail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [unavailable, setUnavailable] = useState<string | null>(null);
	const [epoch, setEpoch] = useState(0);
	const [loaded, setLoaded] = useState(false);
	const [offline, setOffline] = useState(false);
	const detailHeading = useRef<HTMLHeadingElement | null>(null);

	// refs read by async callbacks: the CURRENT token / epoch / selection, not the captured ones
	const epochRef = useRef(0);
	const tokenRef = useRef(token);
	const selectedRef = useRef<string | null>(null);
	const listSeq = useRef(0);
	const detailSeq = useRef(0);
	tokenRef.current = token;
	selectedRef.current = selected;

	/** Drop everything this token could see and invalidate all in-flight work. */
	const purge = useCallback((message: string | null) => {
		epochRef.current++;
		setEpoch(epochRef.current);
		sessionStorage.removeItem(TOKEN_KEY);
		setToken("");
		setAuth("none");
		setInfo(null);
		setTasks([]);
		setSelected(null);
		setDetail(null);
		setUnavailable(null);
		setError(message);
		setLoaded(false);
		setTaskHash(null);
	}, []);

	/** Epoch-guarded request: undefined when the answer belongs to an older token / purge. */
	const call: Call = useCallback(
		async <T,>(path: string, json?: unknown): Promise<T | undefined> => {
			const e = epochRef.current;
			try {
				const res = await api<T>(tokenRef.current, path, json);
				return e === epochRef.current ? res : undefined;
			} catch (err) {
				if (e !== epochRef.current) return undefined; // late, from an older token
				if (err instanceof ApiError && err.status === 401) {
					purge("the hub rejected this token");
					return undefined;
				}
				if (err instanceof ApiError && err.status === 503) {
					setUnavailable(err.message);
					return undefined;
				}
				throw err;
			}
		},
		[purge],
	);

	const loadDetail = useCallback(
		async (id: string) => {
			const seq = ++detailSeq.current;
			try {
				const d = await call<Detail>(`/tasks/${id}`);
				if (!d || seq !== detailSeq.current || selectedRef.current !== id)
					return;
				setOffline(false);
				setDetail((cur) =>
					cur && cur.task.id === id && !newerTask(d.task, cur.task) ? cur : d,
				);
			} catch (err) {
				if (seq !== detailSeq.current) return;
				if (err instanceof ApiError && err.status === 404) {
					// a deep link / stale selection to a task that does not exist (any more)
					setSelected(null);
					setTaskHash(null);
					setError("that task does not exist on this hub");
				} else if (err instanceof ApiError && err.status === 0)
					setOffline(true);
				else setError((err as Error).message);
			}
		},
		[call],
	);

	const refresh = useCallback(async () => {
		if (!tokenRef.current) return;
		const seq = ++listSeq.current;
		try {
			const [cfg, list] = await Promise.all([
				call<ManagedInfo>("/config"),
				call<{ tasks: ManagedTask[] }>("/tasks"),
			]);
			if (!cfg || !list || seq !== listSeq.current) return;
			setInfo(cfg);
			setTasks(list.tasks);
			setUnavailable(null);
			setAuth("ok");
			setLoaded(true);
			setOffline(false);
		} catch (err) {
			if (seq !== listSeq.current) return;
			if (err instanceof ApiError && err.status === 0) setOffline(true);
			else setError((err as Error).message);
		}
		const id = selectedRef.current;
		if (id) await loadDetail(id);
	}, [call, loadDetail]);

	// token accepted / (re)connect / `managed` frame → re-fetch from the hub
	useEffect(() => {
		void managedSeq; // the trigger: bumped by the hub hook on reconnect / managed frames
		void epoch;
		if (token) void refresh();
	}, [refresh, managedSeq, epoch, token]);

	// a new selection → its detail (the previous one is never shown under the new id)
	useEffect(() => {
		if (selected) void loadDetail(selected);
	}, [selected, loadDetail]);

	// fallback poll while something is in flight (covers a dropped socket)
	const busy = tasks.some(isActive);
	useEffect(() => {
		if (!busy) return;
		const t = setInterval(() => void refresh(), 3_000);
		return () => clearInterval(t);
	}, [busy, refresh]);

	const select = (id: string) => {
		setTaskHash(id);
		if (id === selected) {
			void loadDetail(id); // re-clicking refreshes; it never blanks the view
			return;
		}
		setDetail(null);
		setSelected(id);
	};

	// keyboard users land on the detail they opened — once its heading is actually rendered: a
	// deep-linked detail can answer while the token check is still showing the gate (no heading yet)
	const shownDetailId =
		auth === "ok" && !unavailable && detail?.task.id === selected
			? selected
			: null;
	useEffect(() => {
		if (shownDetailId) detailHeading.current?.focus({ preventScroll: true });
	}, [shownDetailId]);

	if (auth === "none")
		return (
			<section className="tasks-gate">
				<h2>Managed tasks</h2>
				<p className="muted">
					Managed tasks can start processes on this machine, so the hub asks for
					a token even on loopback. Paste the value of{" "}
					<code>MANAGED_TOKEN</code> from your <code>.env</code>. It is kept in
					this browser tab only.
				</p>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						const next = draftToken.trim();
						if (!next) return;
						epochRef.current++;
						setEpoch(epochRef.current);
						sessionStorage.setItem(TOKEN_KEY, next);
						setError(null);
						setToken(next);
						setAuth("authenticating");
						setDraftToken("");
					}}
				>
					<input
						type="password"
						aria-label="managed token"
						data-testid="token-input"
						autoComplete="off"
						value={draftToken}
						onChange={(e) => setDraftToken(e.target.value)}
					/>{" "}
					<button type="submit" data-testid="token-submit">
						Use token
					</button>
				</form>
				{error && (
					<p className="err" data-testid="auth-error">
						{error}
					</p>
				)}
			</section>
		);

	if (unavailable)
		return (
			<section className="tasks-gate">
				<h2>Managed tasks</h2>
				<p className="err">
					Managed runs are disabled on this hub: {unavailable}
				</p>
				<p className="muted">
					Set <code>MANAGED_CONFIG</code> and <code>MANAGED_TOKEN</code> and
					restart the hub (see docs/managed-runs.md).
				</p>
				<button type="button" onClick={() => void refresh()}>
					Retry
				</button>
			</section>
		);

	if (auth === "authenticating")
		return (
			<section className="tasks-gate" data-testid="authenticating">
				<h2>Managed tasks</h2>
				<p className="muted">checking the token with the hub…</p>
				{offline && (
					<p className="mnote mnote-warn" data-testid="offline">
						The hub cannot be reached right now; it is retried on reconnect.
					</p>
				)}
				<button
					type="button"
					className="link"
					onClick={() => purge(null)}
					data-testid="forget-token"
				>
					forget token
				</button>
				{error && <p className="err">{error}</p>}
			</section>
		);

	return (
		<div className="tasks">
			<section className="tasks-left">
				<h2>
					Managed tasks <small>{tasks.length}</small>
					<button
						type="button"
						className="link"
						data-testid="forget-token"
						onClick={() => purge(null)}
					>
						forget token
					</button>
				</h2>
				{error && (
					<p className="err">
						{error}{" "}
						<button
							type="button"
							className="link"
							onClick={() => setError(null)}
						>
							dismiss
						</button>
					</p>
				)}
				{info && (
					<NewTask
						key={`new-${epoch}`}
						info={info}
						call={call}
						onCreated={(t) => {
							setDetail(null);
							setSelected(t.id);
							void refresh();
						}}
						onError={(err) => setError((err as Error).message)}
					/>
				)}
				<table className="task-list">
					<thead>
						<tr>
							<th>task</th>
							<th>mode</th>
							<th>state</th>
						</tr>
					</thead>
					<tbody>
						{tasks.map((t) => (
							<tr
								key={t.id}
								data-testid="task-row"
								data-task-id={t.id}
								className={t.id === selected ? "selected" : undefined}
								tabIndex={0}
								aria-selected={t.id === selected}
								onClick={() => select(t.id)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										select(t.id);
									}
								}}
							>
								<td title={t.id}>
									{t.title}
									<div className="muted">{t.repo_id}</div>
								</td>
								<td>
									<Tag
										badge={modeBadge(
											t,
											info?.live_integration_verified ?? false,
										)}
									/>
								</td>
								<td>
									<Tag badge={stateBadge(t)} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
				{offline && (
					<p className="mnote mnote-warn" data-testid="offline">
						The hub cannot be reached right now; showing the last loaded state.
						It refreshes on its own when the connection is back.
					</p>
				)}
				{!loaded && <p className="muted">loading tasks…</p>}
				{loaded && tasks.length === 0 && (
					<p className="muted">no managed tasks yet</p>
				)}
			</section>
			<section className="tasks-right">
				{detail && detail.task.id === selected ? (
					<TaskDetail
						key={`${detail.task.id}-${epoch}`}
						headingRef={detailHeading}
						detail={detail}
						call={call}
						liveVerified={info?.live_integration_verified ?? false}
						onChanged={() => void refresh()}
						onError={(err) => setError((err as Error).message)}
					/>
				) : (
					<p className="muted" data-testid="detail-placeholder">
						{selected ? "loading…" : "select a task to see its attempts"}
					</p>
				)}
			</section>
		</div>
	);
}

// ── create ───────────────────────────────────────────────────────────────────

function NewTask({
	info,
	call,
	onCreated,
	onError,
}: {
	info: ManagedInfo;
	call: Call;
	onCreated: (t: ManagedTask) => void;
	onError: (err: unknown) => void;
}) {
	const [repo, setRepo] = useState(info.repos[0]?.id ?? "");
	const [title, setTitle] = useState("");
	const [objective, setObjective] = useState("");
	const [criteria, setCriteria] = useState("");
	const [scope, setScope] = useState(".");
	const [mode, setMode] = useState<ExecutionMode>("simulated");
	const [scenario, setScenario] = useState<SimulationScenario>("approve");
	const [repairLimit, setRepairLimit] = useState(info.repair_limit.default);
	const [pending, setPending] = useState(false);
	// One key per intended task: a double submit or a retry after a lost response creates one task.
	const key = useRef(newKey());
	/** A create whose outcome is unknown: the key is NOT rotated until that is resolved. */
	const [unknown, setUnknown] = useState<{
		key: string;
		body: Submission;
	} | null>(null);
	const [diverged, setDiverged] = useState(false);

	const current = (): Submission => ({
		repo_id: repo,
		title,
		objective,
		acceptance_criteria: splitLines(criteria),
		approved_scope: splitList(scope),
		execution_mode: mode,
		...(mode === "simulated" ? { simulation_scenario: scenario } : {}),
		repair_limit: repairLimit,
	});

	const send = async (k: string, body: Submission) => {
		if (pending) return;
		setPending(true);
		setDiverged(false);
		try {
			const res = await call<{ task: ManagedTask }>("/tasks", {
				idempotency_key: k,
				...body,
			});
			if (!res) return;
			setUnknown(null);
			key.current = newKey();
			// clear only what still holds the submitted values — later edits are kept
			setTitle((v) => (v === body.title ? "" : v));
			setObjective((v) => (v === body.objective ? "" : v));
			setCriteria((v) =>
				sameSubmission({ ...body, acceptance_criteria: splitLines(v) }, body)
					? ""
					: v,
			);
			onCreated(res.task);
		} catch (err) {
			if (uncertain(err)) setUnknown({ key: k, body });
			onError(err);
		} finally {
			setPending(false);
		}
	};

	const submit = (e: FormEvent) => {
		e.preventDefault();
		const body = current();
		if (unknown) {
			if (sameSubmission(body, unknown.body)) void send(unknown.key, body);
			else setDiverged(true); // never silently rotate the key while the outcome is unknown
			return;
		}
		void send(key.current, body);
	};

	const repoInfo = info.repos.find((r) => r.id === repo);
	return (
		<form className="new-task" onSubmit={submit}>
			<h3>New task</h3>
			<label>
				repository (allowlist)
				<select value={repo} onChange={(e) => setRepo(e.target.value)}>
					{info.repos.map((r) => (
						<option key={r.id} value={r.id}>
							{r.id} @ {r.base_ref}
						</option>
					))}
				</select>
			</label>
			<p className="muted">
				verification:{" "}
				{repoInfo?.verification.length
					? repoInfo.verification.join(", ")
					: "none configured — a run will end blocked"}
			</p>
			<label>
				title
				<input
					required
					maxLength={120}
					data-testid="new-title"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
				/>
			</label>
			<label>
				objective
				<textarea
					required
					maxLength={4000}
					rows={3}
					data-testid="new-objective"
					value={objective}
					onChange={(e) => setObjective(e.target.value)}
				/>
			</label>
			<label>
				acceptance criteria (one per line; commas are kept)
				<textarea
					required
					rows={2}
					data-testid="new-criteria"
					value={criteria}
					onChange={(e) => setCriteria(e.target.value)}
				/>
			</label>
			<label>
				approved scope (path prefixes, comma separated; "." = whole repo)
				<input
					required
					data-testid="new-scope"
					value={scope}
					onChange={(e) => setScope(e.target.value)}
				/>
			</label>
			<div className="row">
				<label>
					execution mode
					<select
						value={mode}
						onChange={(e) => setMode(e.target.value as ExecutionMode)}
					>
						<option value="simulated">
							simulated (fake adapters, no model)
						</option>
						<option value="live" disabled={!info.live.enabled}>
							live (claude → codex)
							{info.live.enabled ? "" : " — disabled in config"}
						</option>
					</select>
				</label>
				{mode === "simulated" && (
					<label>
						scenario
						<select
							data-testid="new-scenario"
							value={scenario}
							onChange={(e) =>
								setScenario(e.target.value as SimulationScenario)
							}
						>
							{info.scenarios.map((s) => (
								<option key={s} value={s}>
									{s}
								</option>
							))}
						</select>
					</label>
				)}
				<label>
					repair limit
					<input
						type="number"
						min={0}
						max={info.repair_limit.max}
						value={repairLimit}
						onChange={(e) => setRepairLimit(Number(e.target.value))}
					/>
				</label>
			</div>
			{mode === "live" && (
				<p className="mnote mnote-warn">
					Live mode runs the real Claude and Codex CLIs with your logins and
					uses your subscription quota.
					{info.live_integration_verified
						? ""
						: " This integration has only been tested against stub executables."}
				</p>
			)}
			{unknown && (
				<div className="mnote mnote-warn" data-testid="uncertain-create">
					The last create got no answer — it may or may not exist.{" "}
					{diverged ? (
						<>
							You changed the form since.{" "}
							<button
								type="button"
								data-testid="recover-original"
								disabled={pending}
								onClick={() => void send(unknown.key, unknown.body)}
							>
								Recover the original request
							</button>{" "}
							<button
								type="button"
								data-testid="start-new"
								disabled={pending}
								onClick={() => {
									setUnknown(null);
									setDiverged(false);
									key.current = newKey();
									void send(key.current, current());
								}}
							>
								Create a new task from the form
							</button>
						</>
					) : (
						"Submitting the same form again recovers it (no duplicate is created)."
					)}
				</div>
			)}
			<button type="submit" disabled={pending} data-testid="create-button">
				{pending ? "creating…" : unknown ? "Retry create" : "Create draft"}
			</button>
			<span className="muted"> nothing runs until you approve it</span>
		</form>
	);
}

// ── detail ───────────────────────────────────────────────────────────────────

interface Viewer {
	artifact: ManagedArtifact;
	attempt: number | null;
	state: "loading" | "ok" | "error";
	text: string;
	truncated: boolean;
}

function TaskDetail({
	headingRef,
	detail,
	call,
	liveVerified,
	onChanged,
	onError,
}: {
	headingRef: RefObject<HTMLHeadingElement | null>;
	detail: Detail;
	call: Call;
	liveVerified: boolean;
	onChanged: () => void;
	onError: (err: unknown) => void;
}) {
	const { task, runs, reviews, artifacts, integrity } = detail;
	const [pending, setPending] = useState<"run" | "cancel" | null>(null);
	const [viewer, setViewer] = useState<Viewer | null>(null);
	const viewSeq = useRef(0);
	const [files, setFiles] = useState<{ status: string; path: string }[] | null>(
		null,
	);

	const act = async (kind: "run" | "cancel") => {
		if (pending) return;
		setPending(kind);
		try {
			await call(`/tasks/${task.id}/${kind}`, {});
			onChanged();
		} catch (err) {
			onError(err);
		} finally {
			setPending(null);
		}
	};

	const fetchArtifact = useCallback(
		(artifactId: string) =>
			call<{ text: string; truncated: boolean }>(
				`/tasks/${task.id}/artifacts/${artifactId}`,
			),
		[call, task.id],
	);

	/** Open an artifact; a late answer can neither reopen a closed viewer nor replace a newer one. */
	const open = async (a: ManagedArtifact) => {
		const seq = ++viewSeq.current;
		const attempt = runs.find((r) => r.id === a.run_id)?.attempt_no ?? null;
		setViewer({
			artifact: a,
			attempt,
			state: "loading",
			text: "",
			truncated: false,
		});
		try {
			const r = await fetchArtifact(a.id);
			if (seq !== viewSeq.current || !r) return;
			setViewer({
				artifact: a,
				attempt,
				state: "ok",
				text: r.text,
				truncated: r.truncated,
			});
		} catch (err) {
			if (seq !== viewSeq.current) return;
			setViewer({
				artifact: a,
				attempt,
				state: "error",
				text: (err as Error).message,
				truncated: false,
			});
		}
	};
	const close = () => {
		viewSeq.current++;
		setViewer(null);
	};

	// changed files of the newest attempt that has evidence
	const latest = [...runs].reverse().find((r) => r.candidate_sha);
	const filesArtifactId = artifacts.find(
		(a) => a.kind === "changed_files" && a.run_id === latest?.id,
	)?.id;
	useEffect(() => {
		setFiles(null);
		if (!filesArtifactId) return;
		let live = true;
		fetchArtifact(filesArtifactId)
			.then((r) => {
				if (live && r) setFiles(JSON.parse(r.text));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [filesArtifactId, fetchArtifact]);

	const reason = blockingReason(task);
	const mode = modeBadge(task, liveVerified);
	const evidence = detail.evidence_integrity ?? null;
	const quarantine = detail.quarantine ?? [];
	return (
		<div
			className="task-detail"
			data-testid="task-detail"
			data-task-id={task.id}
			data-rev={task.rev}
		>
			<h2 ref={headingRef} tabIndex={-1} data-testid="detail-heading">
				{task.title} <Tag badge={mode} />{" "}
				<span data-testid="detail-state">
					<Tag badge={stateBadge(task, integrity)} />
				</span>
			</h2>
			{task.state === "human_ready" && task.execution_mode === "simulated" && (
				<p className="mnote mnote-sim">
					Simulated result. Fake adapters produced and "reviewed" this change;
					no model was called. It shows that the pipeline works, not that the
					work is good.
				</p>
			)}
			{task.state === "human_ready" && task.execution_mode === "live" && (
				<p className="mnote mnote-ok">
					Verification passed and the reviewer approved this exact candidate. It
					has not been merged or pushed — that is your decision.
					{liveVerified
						? ""
						: " Note: the live integration itself has not been verified end to end."}
				</p>
			)}
			{integrity && !integrity.intact && (
				<p className="mnote mnote-bad" data-testid="workspace-integrity">
					Workspace integrity: the workspace no longer matches the reviewed
					candidate: {integrity.reason}
				</p>
			)}
			{evidence && !evidence.intact && (
				<p className="mnote mnote-bad" data-testid="evidence-integrity">
					Evidence integrity: stored evidence does not match what was recorded —{" "}
					{evidence.problems.slice(0, 4).join("; ")}
				</p>
			)}
			{quarantine.length > 0 && (
				<p className="mnote mnote-bad" data-testid="quarantine">
					A process of this task could not be confirmed terminated (pid{" "}
					{quarantine.map((q) => q.pid).join(", ")}). Run and Cancel stay
					blocked until it is proven gone. Last check:{" "}
					{quarantine[0]?.last_check ?? "pending"}
				</p>
			)}
			{reason && <p className="mnote mnote-warn">{reason}</p>}
			<Diagnostics
				diagnosis={diagnose(
					task,
					runs,
					integrity,
					evidence ? evidence.intact : null,
					quarantine.length > 0,
				)}
			/>

			<div className="actions">
				{canRun(task) && quarantine.length === 0 && (
					<button
						type="button"
						data-testid="run-button"
						disabled={pending !== null}
						onClick={() => act("run")}
					>
						{pending === "run" ? "queuing…" : runLabel(task)}
					</button>
				)}
				{canCancel(task) && (
					<button
						type="button"
						data-testid="cancel-button"
						disabled={pending !== null}
						onClick={() => act("cancel")}
					>
						{pending === "cancel" ? "cancelling…" : "Cancel"}
					</button>
				)}
			</div>

			<dl>
				<dt>task</dt>
				<dd>
					<code title={task.id}>{task.id.slice(0, 13)}</code> · rev {task.rev}
				</dd>
				<dt>repository</dt>
				<dd>
					{task.repo_id} @ {task.base_ref} · base{" "}
					<code title={task.base_sha}>{shortSha(task.base_sha)}</code>
				</dd>
				<dt>objective</dt>
				<dd className="pre">{task.objective}</dd>
				<dt>acceptance criteria</dt>
				<dd>
					<ul data-testid="criteria">
						{task.acceptance_criteria.map((c) => (
							<li key={c}>{c}</li>
						))}
					</ul>
				</dd>
				<dt>approved scope</dt>
				<dd>
					<code>{task.approved_scope.join(", ")}</code> · repair limit{" "}
					{task.repair_limit}
					{task.simulation_scenario &&
						` · scenario ${task.simulation_scenario}`}
				</dd>
			</dl>

			<h3>Attempts</h3>
			{runs.length === 0 && <p className="muted">no attempt yet</p>}
			<table>
				<thead>
					<tr>
						<th>#</th>
						<th>kind</th>
						<th>state</th>
						<th>provider · model · session</th>
						<th>candidate</th>
					</tr>
				</thead>
				<tbody>
					{runs.map((r) => (
						<tr key={r.id} title={r.workspace_path ?? ""}>
							<td>{r.attempt_no}</td>
							<td>{r.kind}</td>
							<td>
								{r.state}
								{r.state === "running" && ` (${r.phase})`}
								{r.outcome && ` · ${r.outcome}`}
								{r.failure_kind && (
									<div className="muted">
										{r.failure_kind}: {r.failure_detail}
									</div>
								)}
							</td>
							<td>
								{r.provider} ({r.mode}) · {modelLabel(r)}
								<div className="muted">
									session {r.session_ref ?? "unknown"}
								</div>
							</td>
							<td>
								<code title={r.candidate_sha ?? ""}>
									{shortSha(r.candidate_sha)}
								</code>
								<div className="muted">{r.branch}</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{latest?.workspace_path && (
				<p className="muted">
					workspace (preserved): <code>{latest.workspace_path}</code>
				</p>
			)}

			{files && (
				<>
					<h3>
						Changed files <small>{files.length}</small>
					</h3>
					<ul className="files">
						{files.map((f) => (
							<li key={f.path}>
								<code>{f.status}</code> {f.path}
							</li>
						))}
					</ul>
				</>
			)}

			<h3>Reviews</h3>
			{reviews.length === 0 && <p className="muted">no review yet</p>}
			{reviews.map((rv) => (
				<div key={rv.id} className="review">
					<div>
						<Tag
							badge={
								rv.valid
									? {
											text: rv.verdict ?? "no verdict",
											tone: rv.verdict === "approve" ? "ok" : "bad",
										}
									: { text: "invalid — not counted", tone: "bad" }
							}
						/>{" "}
						{rv.provider} ({rv.mode}) · {modelLabel(rv)} · reviewed{" "}
						<code title={rv.candidate_sha}>{shortSha(rv.candidate_sha)}</code>
					</div>
					{rv.invalidated_reason && (
						<div className="err">{rv.invalidated_reason}</div>
					)}
					{rv.summary && <div className="muted">{rv.summary}</div>}
					<ul>
						{rv.findings.map((f) => (
							<li key={`${f.title}-${f.file}-${f.line}`}>
								<b>{f.severity}</b> {f.title}
								{f.file && (
									<code>
										{" "}
										{f.file}
										{f.line ? `:${f.line}` : ""}
									</code>
								)}
								{!f.actionable && (
									<span className="muted"> (not actionable)</span>
								)}
								<div className="muted pre">{f.detail}</div>
							</li>
						))}
					</ul>
				</div>
			))}

			<h3>Evidence</h3>
			{artifacts.length === 0 && <p className="muted">no evidence yet</p>}
			<ul className="files">
				{artifacts.map((a) => {
					const run = runs.find((r) => r.id === a.run_id);
					const exit = a.meta.exit_code;
					return (
						<li key={a.id}>
							<button
								type="button"
								className="link"
								data-testid="artifact-link"
								data-name={a.name}
								data-attempt={run?.attempt_no ?? ""}
								onClick={() => void open(a)}
							>
								{a.name}
							</button>{" "}
							<span className="muted">
								attempt {run?.attempt_no ?? "?"} · {a.byte_len} B
								{a.truncated && " · truncated"}
								{a.kind === "verification_log" &&
									` · ${a.meta.completed ? `exit ${String(exit)}` : "did not complete"}`}
								{" · "}
								<span title={a.sha256}>sha256 {a.sha256.slice(0, 10)}</span>
							</span>
						</li>
					);
				})}
			</ul>
			{viewer && (
				<div
					className="viewer"
					data-testid="viewer"
					data-name={viewer.artifact.name}
					data-state={viewer.state}
				>
					<div>
						<b>{viewer.artifact.name}</b>{" "}
						<span className="muted">
							task {task.id.slice(0, 13)} · attempt {viewer.attempt ?? "?"} ·
							candidate {shortSha(viewer.artifact.candidate_sha)}
						</span>
						{viewer.truncated && <span className="muted"> (truncated)</span>}{" "}
						<button
							type="button"
							className="link"
							data-testid="viewer-close"
							onClick={close}
						>
							close
						</button>
					</div>
					{viewer.state === "loading" && <p className="muted">loading…</p>}
					{viewer.state === "error" && (
						<p className="mnote mnote-bad" data-testid="viewer-error">
							{viewer.text}
						</p>
					)}
					{viewer.state === "ok" && <pre>{viewer.text}</pre>}
				</div>
			)}
		</div>
	);
}

function Diagnostics({
	diagnosis: d,
}: {
	diagnosis: ReturnType<typeof diagnose>;
}) {
	return (
		<details className="diagnostics" data-testid="diagnostics">
			<summary>Diagnostics — next: {d.nextAction}</summary>
			<dl>
				<dt>stopped at</dt>
				<dd>{d.stage ?? "no attempt yet"}</dd>
				<dt>reason</dt>
				<dd>{d.reason ?? "—"}</dd>
				<dt>last committed state</dt>
				<dd>{d.lastTransition}</dd>
				<dt>workspace integrity</dt>
				<dd>{d.workspace}</dd>
				<dt>evidence integrity</dt>
				<dd>{d.evidence}</dd>
			</dl>
		</details>
	);
}
