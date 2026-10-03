// Strict canonical JSON encoding for workspace-m1 hashes (pure TS; reached via ./hash.ts).
//
// Output is plain JSON with: object keys sorted by UTF-16 code units (JS default string order), no
// insignificant whitespace, strings escaped exactly as JSON.stringify does. Stricter than the hub's
// `canonicalJson` (which silently drops undefined, accepts floats, Dates, Maps…); for every value
// this encoder ACCEPTS, the output is byte-identical to that `canonicalJson`.
//
// Rejected (CanonicalEncodingError with a JSON path): undefined, functions, symbols, bigint, NaN,
// ±Infinity, non-integer numbers and integers beyond ±(2^53−1) (encode such values as strings),
// non-plain objects (Date, Map, Set, RegExp, class instances, typed arrays, boxed primitives),
// symbol keys, accessor / non-enumerable properties, sparse arrays or arrays with extra
// properties, cycles, nesting deeper than 64, and strings
// (values or keys) holding a lone surrogate. -0 encodes as 0. No Unicode normalization is applied:
// "é" (U+00E9) and "é" are different strings and hash differently.
export class CanonicalEncodingError extends Error {
	constructor(
		readonly path: string,
		reason: string,
	) {
		super(`canonical encoding: ${path}: ${reason}`);
		this.name = "CanonicalEncodingError";
	}
}

export const CANONICAL_MAX_DEPTH = 64;

const LONE_SURROGATE =
	/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function encodeString(s: string, path: string): string {
	if (LONE_SURROGATE.test(s))
		throw new CanonicalEncodingError(path, "lone surrogate in string");
	return JSON.stringify(s);
}

function isPlainObject(v: object): boolean {
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

export function canonicalEncode(value: unknown): string {
	const stack = new Set<object>();

	const enc = (v: unknown, path: string, depth: number): string => {
		if (v === null) return "null";
		switch (typeof v) {
			case "boolean":
				return v ? "true" : "false";
			case "string":
				return encodeString(v, path);
			case "number":
				if (!Number.isFinite(v))
					throw new CanonicalEncodingError(path, "non-finite number");
				if (!Number.isInteger(v))
					throw new CanonicalEncodingError(
						path,
						"non-integer number (encode decimals as strings)",
					);
				if (!Number.isSafeInteger(v))
					throw new CanonicalEncodingError(path, "integer beyond ±(2^53−1)");
				return Object.is(v, -0) ? "0" : String(v);
			case "undefined":
			case "function":
			case "symbol":
			case "bigint":
				throw new CanonicalEncodingError(path, `${typeof v} is not encodable`);
		}
		const obj = v as object;
		if (depth >= CANONICAL_MAX_DEPTH)
			throw new CanonicalEncodingError(path, "nesting too deep");
		if (stack.has(obj)) throw new CanonicalEncodingError(path, "cycle");
		stack.add(obj);
		try {
			if (Array.isArray(obj)) {
				if (Object.getPrototypeOf(obj) !== Array.prototype)
					throw new CanonicalEncodingError(path, "non-plain array");
				if (Object.getOwnPropertyNames(obj).length !== obj.length + 1)
					throw new CanonicalEncodingError(
						path,
						"array with holes or extra properties",
					);
				const parts: string[] = [];
				for (let i = 0; i < obj.length; i++) {
					const d = Object.getOwnPropertyDescriptor(obj, i);
					if (!d)
						throw new CanonicalEncodingError(`${path}[${i}]`, "sparse array");
					if (!("value" in d))
						throw new CanonicalEncodingError(
							`${path}[${i}]`,
							"accessor property",
						);
					parts.push(enc(d.value, `${path}[${i}]`, depth + 1));
				}
				return `[${parts.join(",")}]`;
			}
			if (!isPlainObject(obj))
				throw new CanonicalEncodingError(
					path,
					`non-plain object (${Object.prototype.toString.call(obj)})`,
				);
			if (Object.getOwnPropertySymbols(obj).length > 0)
				throw new CanonicalEncodingError(path, "symbol keys");
			const keys = Object.keys(obj).sort();
			if (Object.getOwnPropertyNames(obj).length !== keys.length)
				throw new CanonicalEncodingError(path, "non-enumerable property");
			const parts: string[] = [];
			for (const k of keys) {
				const kp = `${path}.${k}`;
				const d = Object.getOwnPropertyDescriptor(obj, k);
				if (!d || !("value" in d))
					throw new CanonicalEncodingError(kp, "accessor property");
				parts.push(`${encodeString(k, kp)}:${enc(d.value, kp, depth + 1)}`);
			}
			return `{${parts.join(",")}}`;
		} finally {
			stack.delete(obj);
		}
	};

	return enc(value, "$", 0);
}
