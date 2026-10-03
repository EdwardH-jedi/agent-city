import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// Env lives in the repo-root .env; proxy hub routes so the browser stays same-origin (no CORS on the hub).
export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, "../..", "");
	const hubUrl = env.HUB_URL || "http://127.0.0.1:4317";

	return {
		plugins: [react()],
		// Workspace M1 UI when the hub is configured for it (WORKSPACE_ALLOWED_ORIGIN = this UI's origin)
		define: {
			__AGENTCITY_WORKSPACE_UI__: JSON.stringify(
				Boolean(env.WORKSPACE_ALLOWED_ORIGIN),
			),
		},
		server: {
			host: "127.0.0.1",
			proxy: {
				"/healthz": hubUrl,
				"/api": hubUrl,
				// live updates; the hub checks Origin (http://127.0.0.1:5173 is allowed)
				"/ws": { target: hubUrl, ws: true },
			},
		},
	};
});
