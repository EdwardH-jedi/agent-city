import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	CANONICAL_MAX_DEPTH,
	CanonicalEncodingError,
	canonicalEncode,
	hashCanonical,
	hashesEqual,
	sha256Hex,
} from "./hash.ts";

/** Replica of the hub's apps/hub/src/managed/config.ts `canonicalJson` (lenient reference). */
function hubCanonicalJson(value: unknown): string {
	const norm = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(norm);
		if (v && typeof v === "object") {
			const out: Record<string, unknown> = {};
			for (const k of Object.keys(v as object).sort())
				out[k] = norm((v as Record<string, unknown>)[k]);
			return out;
		}
		return v;
	};
	return JSON.stringify(norm(value));
}

const rejects = (v: unknown) =>
	expect(() => canonicalEncode(v)).toThrow(CanonicalEncodingError);

describe("canonicalEncode — accepted values", () => {
	const accepted: [string, unknown, string][] = [
		["null", null, "null"],
		["true", true, "true"],
		["false", false, "false"],
		["zero", 0, "0"],
		["negative int", -17, "-17"],
		["max safe int", Number.MAX_SAFE_INTEGER, "9007199254740991"],
		["min safe int", Number.MIN_SAFE_INTEGER, "-9007199254740991"],
		["empty string", "", '""'],
		["empty array", [], "[]"],
		["empty object", {}, "{}"],
		["quotes and backslash", 'a"b\\c', '"a\\"b\\\\c"'],
		[
			"controls escaped",
			"\u0000\u0001\b\t\n\f\r\u001f",
			'"\\u0000\\u0001\\b\\t\\n\\f\\r\\u001f"',
		],
		["non-ASCII kept raw", "naïve café 日本語 😀", '"naïve café 日本語 😀"'],
		["U+2028 kept raw", "a b", '"a b"'],
		[
			"nested",
			{ b: [1, { d: null, c: "x" }], a: true },
			'{"a":true,"b":[1,{"c":"x","d":null}]}',
		],
		["array order kept", [3, 1, 2], "[3,1,2]"],
	];
	for (const [name, input, out] of accepted)
		test(name, () => {
			expect(canonicalEncode(input)).toBe(out);
			// identical to the hub's canonicalJson for every accepted value
			expect(canonicalEncode(input)).toBe(hubCanonicalJson(input));
		});

	test("-0 encodes as 0", () => {
		expect(canonicalEncode(-0)).toBe("0");
		expect(canonicalEncode({ x: -0 })).toBe('{"x":0}');
	});

	test("keys sort by UTF-16 code units, not code points", () => {
		// U+E000 (one unit 0xE000) vs 😀 U+1F600 (units 0xD83D 0xDE00): code-point order would put
		// U+E000 first; code-unit order puts the emoji first.
		const v = { "": 1, "😀": 2, Z: 3, a: 4, é: 5, "": 6 };
		expect(canonicalEncode(v)).toBe('{"":6,"Z":3,"a":4,"é":5,"😀":2,"":1}');
		expect(canonicalEncode(v)).toBe(hubCanonicalJson(v));
	});

	test("insertion order does not matter", () => {
		expect(canonicalEncode({ a: 1, b: 2 })).toBe(
			canonicalEncode({ b: 2, a: 1 }),
		);
	});

	test("null-prototype objects are plain", () => {
		const o = Object.create(null) as Record<string, unknown>;
		o.k = "v";
		expect(canonicalEncode(o)).toBe('{"k":"v"}');
	});

	test("no Unicode normalization", () => {
		const nfc = "café";
		const nfd = "café";
		expect(canonicalEncode(nfc)).not.toBe(canonicalEncode(nfd));
		expect(hashCanonical(nfc)).not.toBe(hashCanonical(nfd));
	});

	test("the same object twice (not a cycle) is fine", () => {
		const shared = { x: 1 };
		expect(canonicalEncode({ a: shared, b: [shared] })).toBe(
			'{"a":{"x":1},"b":[{"x":1}]}',
		);
	});

	test(`depth up to ${CANONICAL_MAX_DEPTH} is accepted`, () => {
		let v: unknown = 1;
		for (let i = 0; i < CANONICAL_MAX_DEPTH; i++) v = [v];
		expect(() => canonicalEncode(v)).not.toThrow();
		expect(() => canonicalEncode([v])).toThrow(CanonicalEncodingError);
	});
});

describe("canonicalEncode — rejected values", () => {
	test("undefined anywhere", () => {
		rejects(undefined);
		rejects({ a: undefined });
		rejects([undefined]);
	});
	test("functions, symbols, bigint", () => {
		rejects(() => 1);
		rejects(Symbol("s"));
		rejects(10n);
		rejects({ a: 10n });
	});
	test("non-finite, non-integer and unsafe numbers", () => {
		rejects(Number.NaN);
		rejects(Number.POSITIVE_INFINITY);
		rejects(Number.NEGATIVE_INFINITY);
		rejects(1.5);
		rejects(0.1);
		rejects(2 ** 53);
		rejects(-(2 ** 53));
		rejects(1e21);
	});
	test("non-plain objects", () => {
		rejects(new Date(0));
		rejects(new Map());
		rejects(new Set());
		rejects(/x/);
		rejects(new Uint8Array(2));
		rejects(Buffer.from("x"));
		rejects(new (class Foo {})());
		rejects(new String("x"));
		rejects(new Number(1));
		rejects(new Boolean(true));
	});
	test("symbol keys, accessors, non-enumerable properties", () => {
		rejects({ [Symbol("k")]: 1 });
		rejects(Object.defineProperty({}, "g", { get: () => 1, enumerable: true }));
		rejects(
			Object.defineProperty({}, "hidden", { value: 1, enumerable: false }),
		);
	});
	test("sparse arrays and arrays with extra properties", () => {
		// biome-ignore lint/suspicious/noSparseArray: the point of the test
		rejects([1, , 3]);
		rejects(new Array(2));
		const extra = [1, 2] as number[] & { foo?: number };
		extra.foo = 1;
		rejects(extra);
	});
	test("cycles", () => {
		const a: Record<string, unknown> = {};
		a.self = a;
		rejects(a);
		const arr: unknown[] = [];
		arr.push(arr);
		rejects(arr);
	});
	test("lone surrogates in values and keys", () => {
		rejects("\ud800");
		rejects("a\udc00b");
		rejects("\ude00\ud83d"); // reversed pair
		rejects({ "\ud800": 1 });
		expect(canonicalEncode("😀")).toBe('"😀"');
	});
	test("errors name the path", () => {
		try {
			canonicalEncode({ a: [{ b: 1.5 }] });
			throw new Error("unreachable");
		} catch (err) {
			expect(err).toBeInstanceOf(CanonicalEncodingError);
			expect((err as CanonicalEncodingError).path).toBe("$.a[0].b");
		}
	});
});

describe("sha256 helpers", () => {
	test("sha256Hex matches node:crypto and known vectors", () => {
		expect(sha256Hex("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
		expect(sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		const s = '{"a":"é"}';
		expect(sha256Hex(s)).toBe(
			createHash("sha256").update(s, "utf8").digest("hex"),
		);
		expect(sha256Hex(new TextEncoder().encode(s))).toBe(sha256Hex(s));
	});
	test("hashCanonical hashes the UTF-8 of the canonical string", () => {
		expect(hashCanonical({ b: 1, a: "é" })).toBe(sha256Hex('{"a":"é","b":1}'));
	});
	test("hashesEqual is strict about format", () => {
		const h = sha256Hex("x");
		expect(hashesEqual(h, h)).toBe(true);
		expect(hashesEqual(h, sha256Hex("y"))).toBe(false);
		expect(hashesEqual(h, h.toUpperCase())).toBe(false);
		expect(hashesEqual(h, h.slice(1))).toBe(false);
		expect(hashesEqual("", "")).toBe(false);
	});
});
