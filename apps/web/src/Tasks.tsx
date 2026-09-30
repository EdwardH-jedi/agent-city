// Managed tasks: create a bounded task for an allowed repo, approve it to run, watch the attempt,
// inspect evidence and review findings. Talks to /api/managed with a bearer token the user pastes
// (kept in sessionStorage for this tab only). Everything shown is re-fetched from the hub, so a
// refresh or a reconnect loses nothing.
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
	type Integrity,
	isActive,
	modeBadge,
	modelLabel,
	runLabel,
	shortSha,
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
}

class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function api<T>(token: string, path: string, json?: unknown): Promise<T> {
	const res = await fetch(`/api/managed${path}`, {
		method: json === undefined ? "GET" : "POST",
		headers: {
			authorization: `Bearer ${token}`,
			...(json === undefined ? {} : { "content-type": "application/json" }),
		},
		body: json === undefined ? undefined : JSON.stringify(json),
	});
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
			issues ||
				data.message ||
				data.reason ||
				data.error ||
				`HTTP ${res.status}`,
		);
	}
	return data as T;
}

const TOKEN_KEY = "agentcity.managedToken";
const newKey = () => `ui-${crypto.randomUUID()}`;

// ── view ─────────────────────────────────────────────────────────────────────

function Tag({ badge }: { badge: Badge }) {
	return <span className={`mtag mtag-${badge.tone}`}>{badge.text}</span>;
}

export function Tasks({ managedSeq }: { managedSeq: number }) {
	const [token, setToken] = useState(
		() => sessionStorage.getItem(TOKEN_KEY) ?? "",
	);
	const [draftToken, setDraftToken] = useState("");
	const [info, setInfo] = useState<ManagedInfo | null>(null);
	const [tasks, setTasks] = useState<ManagedTask[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [detail, setDetail] = useState<Detail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [unavailable, setUnavailable] = useState<string | null>(null);

	const fail = useCallback((err: unknown) => {
		const e = err as ApiError;
		if (e.status === 401) {
			sessionStorage.removeItem(TOKEN_KEY);
			setToken("");
			setError("the hub rejected this token");
		} else if (e.status === 503) setUnavailable(e.message);
		else setError(e.message);
	}, []);

	const refresh = useCallback(async () => {
		if (!token) return;
		try {
			const [cfg, list] = await Promise.all([
				api<ManagedInfo>(token, "/config"),
				api<{ tasks: ManagedTask[] }>(token, "/tasks"),
			]);
			setInfo(cfg);
			setTasks(list.tasks);
			setUnavailable(null);
			if (selected) setDetail(await api<Detail>(token, `/tasks/${selected}`));
		} catch (err) {
			fail(err);
		}
	}, [token, selected, fail]);

	// (re)connect, a `managed` frame, a new selection → re-fetch from the hub
	useEffect(() => {
		void managedSeq; // the trigger: bumped by the hub hook on reconnect / managed frames
		void refresh();
	}, [refresh, managedSeq]);

	// fallback poll while something is in flight (covers a dropped socket)
	const busy = tasks.some(isActive);
	useEffect(() => {
		if (!busy) return;
		const t = setInterval(() => void refresh(), 3_000);
		return () => clearInterval(t);
	}, [busy, refresh]);

	if (!token)
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
						if (!draftToken.trim()) return;
						sessionStorage.setItem(TOKEN_KEY, draftToken.trim());
						setError(null);
						setToken(draftToken.trim());
						setDraftToken("");
					}}
				>
					<input
						type="password"
						aria-label="managed token"
						autoComplete="off"
						value={draftToken}
						onChange={(e) => setDraftToken(e.target.value)}
					/>{" "}
					<button type="submit">Use token</button>
				</form>
				{error && <p className="err">{error}</p>}
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

	return (
		<div className="tasks">
			<section className="tasks-left">
				<h2>
					Managed tasks <small>{tasks.length}</small>
					<button
						type="button"
						className="link"
						onClick={() => {
							sessionStorage.removeItem(TOKEN_KEY);
							setToken("");
						}}
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
						info={info}
						token={token}
						onCreated={(t) => {
							setSelected(t.id);
							void refresh();
						}}
						onError={fail}
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
								className={t.id === selected ? "selected" : undefined}
								onClick={() => {
									setDetail(null);
									setSelected(t.id);
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
				{tasks.length === 0 && <p className="muted">no managed tasks yet</p>}
			</section>
			<section className="tasks-right">
				{detail && detail.task.id === selected ? (
					<TaskDetail
						detail={detail}
						token={token}
						liveVerified={info?.live_integration_verified ?? false}
						onChanged={() => void refresh()}
						onError={fail}
					/>
				) : (
					<p className="muted">
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
	token,
	onCreated,
	onError,
}: {
	info: ManagedInfo;
	token: string;
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
	// One key per form fill: a double submit (or a retry after a lost response) creates one task.
	const key = useRef(newKey());

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (pending) return;
		setPending(true);
		try {
			const { task } = await api<{ task: ManagedTask }>(token, "/tasks", {
				idempotency_key: key.current,
				repo_id: repo,
				title,
				objective,
				acceptance_criteria: splitList(criteria),
				approved_scope: splitList(scope),
				execution_mode: mode,
				...(mode === "simulated" ? { simulation_scenario: scenario } : {}),
				repair_limit: repairLimit,
			});
			key.current = newKey();
			setTitle("");
			setObjective("");
			setCriteria("");
			onCreated(task);
		} catch (err) {
			onError(err);
		} finally {
			setPending(false);
		}
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
					value={objective}
					onChange={(e) => setObjective(e.target.value)}
				/>
			</label>
			<label>
				acceptance criteria (one per line)
				<textarea
					required
					rows={2}
					value={criteria}
					onChange={(e) => setCriteria(e.target.value)}
				/>
			</label>
			<label>
				approved scope (path prefixes, comma separated; "." = whole repo)
				<input
					required
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
			<button type="submit" disabled={pending}>
				{pending ? "creating…" : "Create draft"}
			</button>
			<span className="muted"> nothing runs until you approve it</span>
		</form>
	);
}

// ── detail ───────────────────────────────────────────────────────────────────

function TaskDetail({
	detail,
	token,
	liveVerified,
	onChanged,
	onError,
}: {
	detail: Detail;
	token: string;
	liveVerified: boolean;
	onChanged: () => void;
	onError: (err: unknown) => void;
}) {
	const { task, runs, reviews, artifacts, integrity } = detail;
	const [pending, setPending] = useState<"run" | "cancel" | null>(null);
	const [viewer, setViewer] = useState<{
		name: string;
		text: string;
		truncated: boolean;
	} | null>(null);
	const [files, setFiles] = useState<{ status: string; path: string }[] | null>(
		null,
	);

	const act = async (kind: "run" | "cancel") => {
		if (pending) return;
		setPending(kind);
		try {
			await api(token, `/tasks/${task.id}/${kind}`, {});
			onChanged();
		} catch (err) {
			onError(err);
		} finally {
			setPending(null);
		}
	};

	const open = useCallback(
		(artifactId: string) =>
			api<{ text: string; truncated: boolean }>(
				token,
				`/tasks/${task.id}/artifacts/${artifactId}`,
			),
		[token, task.id],
	);

	// changed files of the newest attempt that has evidence
	const latest = [...runs].reverse().find((r) => r.candidate_sha);
	const filesArtifactId = artifacts.find(
		(a) => a.kind === "changed_files" && a.run_id === latest?.id,
	)?.id;
	useEffect(() => {
		setFiles(null);
		if (!filesArtifactId) return;
		let live = true;
		open(filesArtifactId)
			.then((r) => {
				if (live) setFiles(JSON.parse(r.text));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [filesArtifactId, open]);

	const reason = blockingReason(task);
	const mode = modeBadge(task, liveVerified);
	return (
		<div className="task-detail">
			<h2>
				{task.title} <Tag badge={mode} />{" "}
				<Tag badge={stateBadge(task, integrity)} />
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
				<p className="mnote mnote-bad">
					The workspace no longer matches the reviewed candidate:{" "}
					{integrity.reason}
				</p>
			)}
			{reason && <p className="mnote mnote-warn">{reason}</p>}

			<div className="actions">
				{canRun(task) && (
					<button
						type="button"
						disabled={pending !== null}
						onClick={() => act("run")}
					>
						{pending === "run" ? "queuing…" : runLabel(task)}
					</button>
				)}
				{canCancel(task) && (
					<button
						type="button"
						disabled={pending !== null}
						onClick={() => act("cancel")}
					>
						{pending === "cancel" ? "cancelling…" : "Cancel"}
					</button>
				)}
			</div>

			<dl>
				<dt>repository</dt>
				<dd>
					{task.repo_id} @ {task.base_ref} · base{" "}
					<code title={task.base_sha}>{shortSha(task.base_sha)}</code>
				</dd>
				<dt>objective</dt>
				<dd className="pre">{task.objective}</dd>
				<dt>acceptance criteria</dt>
				<dd>
					<ul>
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
								onClick={() =>
									open(a.id)
										.then((r) => setViewer({ name: a.name, ...r }))
										.catch(onError)
								}
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
				<div className="viewer">
					<div>
						<b>{viewer.name}</b>
						{viewer.truncated && <span className="muted"> (truncated)</span>}{" "}
						<button
							type="button"
							className="link"
							onClick={() => setViewer(null)}
						>
							close
						</button>
					</div>
					<pre>{viewer.text}</pre>
				</div>
			)}
		</div>
	);
}
