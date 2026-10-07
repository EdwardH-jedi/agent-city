// Root of the M1 workspace (role 07). Mount: `<WorkspaceApp activity={<ObservedView/>} />`.
// Landmarks (MATRIX §7): one banner header, one nav "Primary", one main; the first focusable
// element is "Skip to task panel". DOM-first: no canvas, no WebGL, no animation.
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { loadWorkspaceTransport } from "./config.ts";
import { EvidenceViewer } from "./Evidence.tsx";
import { HqView } from "./HqView.tsx";
import { clockTime, connectionIsStale, FIXTURE_NOTE } from "./labels.ts";
import { ProjectsView } from "./ProjectsView.tsx";
import {
	Chip,
	focusById,
	PANEL_TITLE_ID,
	StoreContext,
	useWs,
} from "./parts.tsx";
import { parseHash } from "./route.ts";
import { WorkspaceStore } from "./store.ts";
import type { WorkspaceTransport } from "./transport.ts";
import { useWorkspaceRuntime, useWorkspaceState } from "./useWorkspace.ts";
import "./workspace.css";

export interface WorkspaceAppProps {
	/** Injected transport (dev / tests). Default: chosen by the build-time define (config.ts). */
	transport?: WorkspaceTransport;
	/** The read-only observed-telemetry view shown under "Activity". */
	activity?: ReactNode;
}

export function WorkspaceApp({ transport, activity }: WorkspaceAppProps) {
	const [store, setStore] = useState<WorkspaceStore | null>(null);
	useEffect(() => {
		let alive = true;
		void (
			transport ? Promise.resolve(transport) : loadWorkspaceTransport()
		).then((t) => {
			if (alive)
				setStore(
					new WorkspaceStore({ transport: t }, parseHash(location.hash)),
				);
		});
		return () => {
			alive = false;
		};
	}, [transport]);
	if (!store)
		return (
			<div className="wsm1 wsm1-booting">
				<p>Loading workspace…</p>
			</div>
		);
	return <Shell store={store} activity={activity} />;
}

function Shell({
	store,
	activity,
}: {
	store: WorkspaceStore;
	activity?: ReactNode;
}) {
	const state = useWorkspaceState(store);
	useWorkspaceRuntime(store, state.route, state.routeMode);

	// selection → focus the detail heading
	useEffect(() => {
		if (state.focusSeq > 0) focusById(PANEL_TITLE_ID);
	}, [state.focusSeq]);

	// viewer closed → focus returns to the control that opened it
	const opener = useRef<string | null>(null);
	useEffect(() => {
		if (state.viewer) opener.current = state.viewer.openerId;
		else if (opener.current) {
			focusById(opener.current);
			opener.current = null;
		}
	}, [state.viewer]);

	const signedIn = state.auth.status === "signed_in";
	return (
		<StoreContext.Provider value={{ store, state }}>
			<div className="wsm1" data-source={state.source}>
				<a
					className="wsm1-skip"
					href={`#${PANEL_TITLE_ID}`}
					onClick={(e) => {
						e.preventDefault();
						focusById(signedIn ? PANEL_TITLE_ID : "wsm1-signin-title");
					}}
				>
					Skip to task panel
				</a>
				<TopBar />
				{signedIn ? <Rail /> : <div className="wsm1-rail" aria-hidden="true" />}
				<main className="wsm1-main">
					{state.alert ? <AlertBox /> : null}
					{!signedIn ? (
						<SignIn />
					) : state.route.view === "hq" ? (
						<HqView />
					) : state.route.view === "activity" ? (
						<Activity>{activity}</Activity>
					) : (
						<ProjectsView />
					)}
				</main>
				{state.viewer ? (
					<EvidenceViewer key={state.viewer.artifactId} viewer={state.viewer} />
				) : null}
			</div>
		</StoreContext.Provider>
	);
}

function TopBar() {
	const { store, state } = useWs();
	const p = state.snapshot?.provenance;
	const source = p?.data_source ?? state.source;
	const mode = p?.execution_mode ?? "simulated";
	const verified = p?.live_integration_verified ?? false;
	// review repair APP-P2-02: the complete pending total, not the bounded first page
	const pending =
		state.snapshot?.pending_page?.total ??
		state.snapshot?.pending_requests.length ??
		0;
	const signedIn = state.auth.status === "signed_in";
	const offline = state.conn.status === "offline";
	const stale = state.conn.status === "online" && connectionIsStale(state.conn);
	return (
		<header className="wsm1-top">
			<div className="wsm1-brand">
				<span className="wsm1-brand-name">Agent City</span>
				<span className="wsm1-brand-sub">Workspace</span>
			</div>
			<div
				className="wsm1-provenance"
				data-testid="provenance"
				data-source={source}
				data-mode={mode}
				data-integration={verified ? "verified" : "unverified"}
				title={source === "fixture" ? FIXTURE_NOTE : undefined}
			>
				<span
					className={`wsm1-tag ${source === "fixture" ? "wsm1-tag-fixture" : ""}`}
				>
					{source === "fixture" ? "UI fixture" : "Hub record"}
				</span>
				<span className="wsm1-tag">
					{mode === "simulated" ? "Simulated" : "Live"}
				</span>
				<span className="wsm1-tag">
					Integration {verified ? "verified" : "unverified"}
				</span>
			</div>
			<output
				aria-label="Connection"
				className={`wsm1-conn ${offline || stale ? "wsm1-conn-off" : ""}`}
			>
				{offline
					? `Offline · last confirmed ${clockTime(state.conn.lastConfirmedAt)} · data may be stale`
					: stale
						? `Connection stale · last confirmed ${clockTime(state.conn.lastConfirmedAt)} · data may be stale`
						: state.conn.status === "connecting"
							? "Connecting…"
							: `Online · last confirmed ${clockTime(state.conn.lastConfirmedAt)}`}
			</output>
			{signedIn ? (
				<>
					<button
						type="button"
						className="wsm1-top-button"
						onClick={() =>
							store.navigate({
								view: "hq",
								repoId: null,
								taskId: null,
								requestId: null,
							})
						}
					>
						Pending approvals{" "}
						<span className="wsm1-count" data-testid="hq-pending-count">
							{pending}
						</span>
					</button>
					<span className="wsm1-who">
						Signed in as {state.auth.session?.operator_id}
						{state.auth.session?.scopes.includes("workspace:decide")
							? ""
							: " (read only)"}
					</span>
					<button
						type="button"
						className="wsm1-top-button"
						onClick={() => void store.signOut()}
					>
						Sign out
					</button>
				</>
			) : null}
		</header>
	);
}

const NAV: {
	view: "projects" | "hq" | "activity";
	href: string;
	label: ReactNode;
	icon: ReactNode;
}[] = [
	{
		view: "projects",
		href: "#/projects",
		label: "Projects",
		icon: (
			<svg viewBox="0 0 20 20" aria-hidden="true">
				<path d="M3 17V6l5-3v14M8 17V8h9v9M2 17h16M11 11h1m2 0h1m-4 3h1m2 0h1" />
			</svg>
		),
	},
	{
		view: "hq",
		href: "#/hq",
		label: (
			<>
				Head
				<wbr />
				quarters
			</>
		),
		icon: (
			<svg viewBox="0 0 20 20" aria-hidden="true">
				<path d="M3 17V4h14v13M2 17h16M7 7h2m2 0h2M7 10h2m2 0h2M8 17v-3h4v3" />
			</svg>
		),
	},
	{
		view: "activity",
		href: "#/activity",
		label: "Activity",
		icon: (
			<svg viewBox="0 0 20 20" aria-hidden="true">
				<path d="M2 10h4l2-5 4 10 2-5h4" />
			</svg>
		),
	},
];

function Rail() {
	const { store, state } = useWs();
	return (
		<nav aria-label="Primary" className="wsm1-rail">
			<ul>
				{NAV.map((n) => (
					<li key={n.view}>
						<a
							href={n.href}
							aria-current={state.route.view === n.view ? "page" : undefined}
							onClick={(e) => {
								e.preventDefault();
								store.navigate({
									view: n.view,
									repoId: null,
									taskId: null,
									requestId: null,
								});
							}}
						>
							{n.icon}
							<span>{n.label}</span>
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}

function AlertBox() {
	const { store, state } = useWs();
	const a = state.alert;
	if (!a) return null;
	return (
		<div role="alert" className="wsm1-alert">
			<p className="wsm1-alert-msg">{a.message}</p>
			<p>{a.lastConfirmed}</p>
			<p>Next: {a.next}</p>
			<button type="button" onClick={() => store.dismissAlert()}>
				Dismiss
			</button>
		</div>
	);
}

function SignIn() {
	const { store, state } = useWs();
	const [value, setValue] = useState("");
	const id = useId();
	if (state.auth.status === "checking")
		return (
			<div className="wsm1-signin">
				<h2 id="wsm1-signin-title" tabIndex={-1}>
					Checking session…
				</h2>
			</div>
		);
	return (
		<div className="wsm1-signin">
			<form
				aria-labelledby="wsm1-signin-title"
				onSubmit={(e) => {
					e.preventDefault();
					const credential = value;
					setValue(""); // never kept in state after the attempt
					void store.signIn(credential);
				}}
			>
				<h2 id="wsm1-signin-title" tabIndex={-1}>
					Operator sign-in
				</h2>
				{state.auth.notice ? (
					<p className="wsm1-hint">{state.auth.notice}</p>
				) : null}
				<div className="wsm1-field">
					<label htmlFor={`${id}-cred`}>Operator credential</label>
					<input
						id={`${id}-cred`}
						type="password"
						autoComplete="off"
						value={value}
						onChange={(e) => setValue(e.target.value)}
					/>
				</div>
				<button
					type="submit"
					className="wsm1-primary"
					disabled={state.auth.busy}
				>
					Sign in
				</button>
				{state.auth.error ? (
					<p role="alert" className="wsm1-error-text">
						{state.auth.error}
					</p>
				) : null}
				<p className="wsm1-hint">
					The credential is exchanged once for a session cookie and is never
					stored by this page.
					{state.source === "fixture"
						? " UI fixture: any test value of 16 or more characters signs in."
						: ""}
				</p>
			</form>
		</div>
	);
}

function Activity({ children }: { children?: ReactNode }) {
	return (
		<section aria-label="Activity" className="wsm1-card wsm1-activity">
			<div className="wsm1-card-head">
				<h2 id={PANEL_TITLE_ID} tabIndex={-1}>
					Activity
				</h2>
				<Chip tone="neutral">Observed only</Chip>
			</div>
			<p className="wsm1-note">
				Telemetry from observed agent sessions, read-only. Nothing here queues,
				approves, accepts or cancels work.
			</p>
			{children ?? (
				<p className="wsm1-muted">
					The observed-sessions view is not attached in this build.
				</p>
			)}
		</section>
	);
}
