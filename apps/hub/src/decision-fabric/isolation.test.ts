// Test 12 — Decision Fabric makes no network call, spawns no process and invokes no model.
// Runtime: fetch / Bun.spawn / Bun.spawnSync / Bun.connect are replaced with throwing stubs while
// every kind is decided through every fake provider. Source: non-test files may import only zod,
// node:crypto and siblings, and policy.ts may not import a provider at all.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decide } from "./fabric.ts";
import {
	fixedProvider,
	hangingProvider,
	rawProvider,
	rulesProvider,
	throwingProvider,
} from "./fake-provider.ts";
import { ONE_OF_EACH } from "./testkit.ts";

const DIR = import.meta.dir;
const SOURCES = readdirSync(DIR).filter(
	(f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
);
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const importsOf = (src: string) =>
	[...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)].map(
		(m) => m[1] ?? "",
	);

describe("12 — no network / process / model invocation", () => {
	const touched: string[] = [];
	const originalFetch = globalThis.fetch;
	const spies: { mockRestore(): void }[] = [];

	beforeAll(() => {
		globalThis.fetch = ((..._args: unknown[]) => {
			touched.push("fetch");
			throw new Error("network is not allowed in decision-fabric");
		}) as unknown as typeof fetch;
		for (const name of ["spawn", "spawnSync", "connect"] as const)
			spies.push(
				spyOn(Bun, name).mockImplementation((() => {
					touched.push(`Bun.${name}`);
					throw new Error(`Bun.${name} is not allowed in decision-fabric`);
				}) as never),
			);
	});

	afterAll(() => {
		globalThis.fetch = originalFetch;
		for (const s of spies) s.mockRestore();
	});

	test("deciding every kind with every fake provider touches nothing", async () => {
		const providers = [
			rulesProvider(),
			fixedProvider({ choice: "HUMAN", confidence: 0.5 }),
			throwingProvider(),
			rawProvider(() => ({ reasoning: "x" })),
		];
		let outcomes = 0;
		for (const req of ONE_OF_EACH) {
			for (const p of providers) {
				await decide(p, req);
				outcomes++;
			}
			await decide(hangingProvider(), req, { timeout_ms: 2 });
			outcomes++;
		}
		await decide(rulesProvider(), { decision_kind: "UNKNOWN", input: {} });
		expect(outcomes).toBe(ONE_OF_EACH.length * 5);
		expect(touched).toEqual([]);
	});

	test("the stubs are live (sanity: they would have caught a call)", () => {
		expect(() => fetch("http://127.0.0.1:9/")).toThrow(
			"network is not allowed",
		);
		expect(() => Bun.spawnSync(["/usr/bin/true"])).toThrow("not allowed");
		expect(touched).toEqual(["fetch", "Bun.spawnSync"]);
		touched.length = 0;
	});
});

describe("12 — source boundaries", () => {
	test("the module has the expected non-test files", () => {
		expect(SOURCES.sort()).toEqual([
			"contracts.ts",
			"fabric.ts",
			"fake-provider.ts",
			"hash.ts",
			"policy.ts",
			"provider.ts",
			"testkit.ts",
			"vocabulary.ts",
		]);
	});

	test("non-test files import only zod, node:crypto and siblings (+ the canonical schema in vocabulary.ts)", () => {
		const bad: string[] = [];
		for (const f of SOURCES)
			for (const spec of importsOf(read(f)))
				if (
					spec !== "zod" &&
					spec !== "node:crypto" &&
					!(f === "vocabulary.ts" && spec === "@agent-city/schema") &&
					!/^\.\/[a-z-]+\.ts$/.test(spec)
				)
					bad.push(`${f}: ${spec}`);
		expect(bad).toEqual([]);
	});

	test("no network, process, environment or dynamic-import APIs in non-test files", () => {
		const forbidden =
			/\bfetch\s*\(|\bBun\.|\bchild_process\b|\bWebSocket\b|\bXMLHttpRequest\b|\bprocess\.|\brequire\s*\(|\bimport\s*\(|\bnode:(?:net|http|https|tls|dgram|fs|child_process)\b/;
		const bad = SOURCES.filter((f) => forbidden.test(read(f)));
		expect(bad).toEqual([]);
	});

	test("policy is independent of providers; only fabric.ts reaches hash + policy + provider", () => {
		expect(importsOf(read("policy.ts")).sort()).toEqual([
			"./contracts.ts",
			"./vocabulary.ts",
		]);
		expect(importsOf(read("vocabulary.ts"))).toEqual([
			"@agent-city/schema",
			"zod",
		]);
		for (const f of SOURCES)
			if (f !== "fabric.ts" && f !== "isolation.test.ts")
				expect(importsOf(read(f))).not.toContain("./fabric.ts");
	});
});
