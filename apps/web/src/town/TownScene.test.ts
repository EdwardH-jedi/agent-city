import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Run the actual component with controlled hook queues and a stage spy, without global module
// mocks leaking into the real stage tests. AB4 separately covers real React and browser frames.
const hooks = `
const refs = [], layouts = [], passives = [], cleanups = [];
let cursor = 0, mountQueued = false;
export const calls = { creates: [], updates: [], disposed: 0 };
export function beginRender() { cursor = 0; }
export function useRef(value) { return refs[cursor++] ??= { current: value }; }
export function useLayoutEffect(effect) { layouts.push(effect); }
export function useEffect(effect, deps) {
  if (deps.length === 0) {
    if (!mountQueued) passives.push(effect);
    mountQueued = true;
  } else passives.push(effect);
}
export function flushLayout() { for (const effect of layouts.splice(0)) effect(); }
export function flushPassive() {
  for (const effect of passives.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  }
}
export function unmount() { for (const cleanup of cleanups.splice(0)) cleanup(); }
export function createTownStage(host, input) {
  calls.creates.push({host, input});
  return {
    update(next) { calls.updates.push(next); },
    dispose() { calls.disposed++; }
  };
}
`;

test("TownScene drops pre-creation updates and constructs the stage from the latest committed props", async () => {
	const source = fileURLToPath(new URL("./TownScene.tsx", import.meta.url));
	const built = await Bun.build({
		entrypoints: ["mount-contract-entry"],
		target: "bun",
		plugins: [
			{
				name: "isolated-town-scene-contract",
				setup(build) {
					build.onResolve({ filter: /^mount-contract-entry$/ }, () => ({
						path: "entry",
						namespace: "mount-contract",
					}));
					build.onResolve(
						{
							filter:
								/^(react|react\/jsx(?:-dev)?-runtime|town-scene-hooks|\.\/stage\.ts)$/,
						},
						({ path }) => ({
							path: path.startsWith("react/jsx") ? "jsx" : "hooks",
							namespace: "mount-contract",
						}),
					);
					build.onLoad(
						{ filter: /.*/, namespace: "mount-contract" },
						({ path }) => ({
							loader: "js",
							contents:
								path === "entry"
									? `export {default as render} from ${JSON.stringify(source)}; export * from 'town-scene-hooks';`
									: path === "jsx"
										? "export const jsx = (type, props) => ({type, props}); export const jsxs = jsx, jsxDEV = jsx;"
										: hooks,
						}),
					);
				},
			},
		],
	});
	expect(built.success).toBe(true);
	const code = await built.outputs[0]?.text();
	expect(code).toBeDefined();
	const directory = mkdtempSync(join(tmpdir(), "agent-city-mount-"));
	const fixture = await (async () => {
		try {
			const target = join(directory, "contract.mjs");
			writeFileSync(target, code ?? "");
			return await import(pathToFileURL(target).href);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	})();
	const host = { id: "mount-contract-host" };
	const first = {
		model: { version: 1 },
		reducedMotion: false,
		time: "day",
		requestedInterior: "station0",
		interiorSource: { version: 1 },
		tourOff: true,
		interiorCommand: { serial: 1, index: 0 },
	};
	const latest = {
		...first,
		model: { version: 2 },
		time: "night",
		interiorSource: { version: 2 },
		interiorCommand: { serial: 2, index: null },
	};
	const render = (input: typeof first | typeof latest) => {
		fixture.beginRender();
		const element = fixture.render({ ...input, onUnavailable() {} });
		element.props.ref.current = host;
		fixture.flushLayout();
	};

	// Hold passive creation while layout updates arrive: none is queued for replay on the stage.
	render(first);
	render(latest);
	expect(fixture.calls).toEqual({ creates: [], updates: [], disposed: 0 });
	fixture.flushPassive();
	expect(fixture.calls.creates).toEqual([{ host, input: latest }]);
	expect(fixture.calls.updates).toEqual([]);

	// Once mounted, the next committed input is delivered during layout, before passive effects.
	const next = { ...latest, model: { version: 3 } };
	render(next);
	expect(fixture.calls.updates).toEqual([next]);
	fixture.unmount();
	expect(fixture.calls.disposed).toBe(1);
});
