// Single source of secret-detection rules, shared by redact.ts (masking) and
// scripts/check-secrets.ts (pre-commit scan). Regexes here are non-global; callers add flags.

export interface SecretPattern {
	name: string;
	re: RegExp;
}

/**
 * Self-identifying token formats — masked wholesale wherever they appear. Prefixes are matched
 * case-insensitively (GHP_…, XOXC-…); quantifiers are bounded so matching stays linear.
 */
export const TOKEN_PATTERNS: readonly SecretPattern[] = [
	// ghp_ gho_ ghu_ ghs_ ghr_
	{ name: "github token", re: /\bgh[pousr]_[A-Za-z0-9]{20,255}/i },
	{ name: "github fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{20,255}/i },
	{ name: "anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{16,255}/i },
	{ name: "openai-style key", re: /\bsk-[A-Za-z0-9_-]{16,255}/i },
	// xoxa- xoxb- xoxc- xoxd- xoxe- xoxp- xoxr- xoxs- …
	{ name: "slack token", re: /\bxox[a-z]-[A-Za-z0-9-]{10,255}/i },
	{ name: "aws access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/i },
	{ name: "google api key", re: /\bAIza[0-9A-Za-z_-]{35}/i },
	{
		name: "jwt",
		re: /\beyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,2048}/i,
	},
	{
		// No END marker (truncated / partial paste) → everything after BEGIN is hidden.
		name: "private key",
		re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]{0,40}PRIVATE KEY-----|[\s\S]*)/i,
	},
];

/**
 * Scan-only: a literal credential after an auth scheme. Requires 20+ chars so code like
 * `Bearer ${token}` isn't flagged; redact.ts masks any length.
 */
export const AUTH_CREDENTIAL_SCAN: SecretPattern = {
	name: "authorization credential",
	re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{20,}=*/,
};

export const SCAN_PATTERNS: readonly SecretPattern[] = [
	...TOKEN_PATTERNS,
	AUTH_CREDENTIAL_SCAN,
];

const SECRET_NAME_PARTS = [
	"secret",
	"password",
	"passwd",
	"pwd",
	"credential",
	"token",
	"apikey",
	"auth",
	"privatekey",
	"accesskey",
	"sessionkey",
	"cookie",
] as const;

// Names that contain a secret word but aren't secrets.
const NOT_SECRET_NAMES: ReadonlySet<string> = new Set([
	"maxtokens",
	"author",
	"authors",
	"tokenizer",
]);

/**
 * Does a key / variable / flag name denote a secret? Normalizes (lowercase, drop non-alphanumerics)
 * so `API_KEY`, `api-key`, `apiKey`, `--api-key` all match. Used for both object keys and `NAME=value`.
 */
export function isSecretName(name: string): boolean {
	const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (n.length === 0 || NOT_SECRET_NAMES.has(n)) return false;
	return SECRET_NAME_PARTS.some((part) => n.includes(part));
}
