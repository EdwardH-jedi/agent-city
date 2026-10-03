// Dev-only campus preview (Worker B; never part of the app bundle). Mounts CampusView over the
// EXISTING fixture store exactly as the lead will: WorkspaceStore + the fixture transport chosen by
// the build-time define → toCampusModel(state) → CampusView, intents bound by createCampusActions to
// store.navigate (selection only). The page frame imitates the workspace grid (top bar, rail,
// left pane, right panel) at its real widths so screenshots show the campus at integration size.
//
// Query (dev only): seed=1 seeds the fixture's demo tasks through its public routes; invalid=1 then
// marks the accepted task's result invalid (fixture control → real store path); repos=N appends N
// placeholder repositories to the MODEL for a layout stress view; nomount=1 starts unmounted.
import { StrictMode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	FIXTURE_CONTROLS_GLOBAL,
	loadWorkspaceTransport,
} from "../../config.ts";
import type { FixtureControls } from "../../fixture-transport.ts";
import { PHASE_LABEL } from "../../labels.ts";
import { parseHash } from "../../route.ts";
import { WorkspaceStore } from "../../store.ts";
import { useWorkspaceRuntime, useWorkspaceState } from "../../useWorkspace.ts";
import { createCampusActions } from "../actions.ts";
import { CampusView } from "../CampusView.tsx";
import type { CampusActions, CampusModel } from "../presentation.ts";
import { toCampusModel } from "../presentation.ts";
import "../../workspace.css";
import "./preview.css";

interface PreviewHooks {
	intents: string[];
	setMounted(on: boolean): void;
	ready: boolean;
	seeded: Record<string, string> | null;
}

const params = new URLSearchParams(location.search);
const EXTRA = Math.max(0, Math.min(24, Number(params.get("repos") ?? 0) || 0));
const hooks: PreviewHooks = {
	intents: [],
	setMounted: () => undefined,
	ready: false,
	seeded: null,
};
(globalThis as Record<string, unknown>).__campusPreview = hooks;

function withPlaceholderRepos(m: CampusModel, n: number): CampusModel {
	if (n === 0) return m;
	const extra = Array.from({ length: n }, (_, i) => {
		const repo_id = `local/preview-${String(i + 1).padStart(2, "0")}`;
		return {
			repo_id,
			label: `preview-${String(i + 1).padStart(2, "0")}`,
			selected: m.selected.repo_id === repo_id,
			active_tasks: i % 3,
			pending_requests: 0,
			has_invalid_acceptance: false,
		};
	});
	return { ...m, repos: [...m.repos, ...extra] };
}

function Preview({ store }: { store: WorkspaceStore }) {
	const state = useWorkspaceState(store);
	useWorkspaceRuntime(store, state.route, state.routeMode);
	const model = useMemo(
		() => withPlaceholderRepos(toCampusModel(state), EXTRA),
		[state],
	);
	const latest = useRef(model);
	useLayoutEffect(() => {
		latest.current = model;
	});
	const [log, setLog] = useState<{ n: number; line: string }[]>([]);
	const [mounted, setMounted] = useState(!params.has("nomount"));
	hooks.setMounted = setMounted;

	const actions = useMemo<CampusActions>(() => {
		const inner = createCampusActions(
			(r) => store.navigate(r),
			() => latest.current,
		);
		const note = (line: string) => {
			hooks.intents = [...hooks.intents, line];
			setLog((l) => [{ n: hooks.intents.length, line }, ...l].slice(0, 6));
		};
		return {
			selectRepo: (id) => {
				note(`selectRepo(${id})`);
				inner.selectRepo(id);
			},
			selectTask: (id) => {
				note(`selectTask(${id})`);
				inner.selectTask(id);
			},
			openRequest: (id) => {
				note(`openRequest(${id})`);
				inner.openRequest(id);
			},
		};
	}, [store]);

	const repoTasks = model.tasks.filter(
		(t) => !model.selected.repo_id || t.repo_id === model.selected.repo_id,
	);
	return (
		<div className="wsm1 cmpv">
			<header className="cmpv-top">
				<span className="wsm1-brand-name">Agent City</span>
				<span className="cmpv-muted">
					Campus preview · UI fixture · dev only
				</span>
			</header>
			<div className="cmpv-rail" aria-hidden="true" />
			<main className="cmpv-main">
				<div className="cmpv-left">
					<div className="cmpv-campus">
						{mounted ? <CampusView model={model} actions={actions} /> : null}
					</div>
					<section className="wsm1-card cmpv-tasks" aria-label="Tasks">
						<div className="wsm1-card-head">
							<h2>
								Tasks
								{model.selected.repo_id ? ` · ${model.selected.repo_id}` : ""}
							</h2>
						</div>
						<ul className="wsm1-list">
							{repoTasks.map((t) => (
								<li key={t.task_id}>
									<button
										type="button"
										className="wsm1-item"
										aria-current={t.selected ? "true" : undefined}
										onClick={() => actions.selectTask(t.task_id)}
									>
										<span className="wsm1-item-title wsm1-wrap">
											{t.title || "Untitled task"}
										</span>
										<span className="cmpv-muted">{PHASE_LABEL[t.phase]}</span>
									</button>
								</li>
							))}
						</ul>
					</section>
				</div>
				<section className="wsm1-card cmpv-panel" aria-label="Preview log">
					<div className="wsm1-card-head">
						<h2>Preview · intents emitted</h2>
					</div>
					<p className="cmpv-muted">
						Selection only. Route: {model.view}
						{model.selected.repo_id ? ` · ${model.selected.repo_id}` : ""}
						{model.selected.request_id ? ` · ${model.selected.request_id}` : ""}
					</p>
					<ol className="cmpv-log" data-testid="intent-log">
						{log.map((l) => (
							<li key={l.n}>
								<code>{l.line}</code>
							</li>
						))}
					</ol>
				</section>
			</main>
		</div>
	);
}

async function boot() {
	const transport = await loadWorkspaceTransport();
	const store = new WorkspaceStore({ transport }, parseHash(location.hash));
	const controls = (globalThis as Record<string, unknown>)[
		FIXTURE_CONTROLS_GLOBAL
	] as FixtureControls | undefined;
	if (controls && params.get("seed") === "1") {
		hooks.seeded = await controls.seedDemo();
		const accepted = hooks.seeded.accepted;
		if (params.get("invalid") === "1" && accepted)
			controls.setAcceptanceValidity(accepted, "invalid", "bundle_corrupt");
	}
	const root = document.getElementById("root");
	if (!root) throw new Error("#root not found");
	createRoot(root).render(
		<StrictMode>
			<Preview store={store} />
		</StrictMode>,
	);
	hooks.ready = true;
}

void boot();
