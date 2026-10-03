// Dev entry of the UI fixture page (role 07; dev only, never part of the app bundle). It mounts
// WorkspaceApp WITHOUT injecting a transport, so the build-time define switch (config.ts) is what
// selects the fixture — a dev server started without the define talks to the hub instead.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceApp } from "../WorkspaceApp.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
	<StrictMode>
		<WorkspaceApp />
	</StrictMode>,
);
