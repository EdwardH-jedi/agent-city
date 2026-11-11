// Whether this page shows 예시 데이터 (`?demo=1`). Tiny on purpose: the live bundle imports only this;
// the made-up data itself (demo.ts) is in a lazy chunk that the live path never loads (§13.9).
export const isDemo = (search: string): boolean =>
	new URLSearchParams(search).get("demo") === "1";

export const DEMO_LABEL = "예시 데이터";
