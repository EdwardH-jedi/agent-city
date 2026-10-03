// Public surface of the workspace pipeline bridge (role 05). test-support.ts is test-only and
// deliberately not exported.
export {
	AUTHORIZED_STAGES,
	type Authorized,
	createAuthorizer,
	type DenialClass,
	type Denied,
	evaluateAuthorization,
} from "./authorize.ts";
export {
	createWorkspaceBridge,
	type WorkspaceBridge,
	type WorkspaceBridgeDeps,
} from "./bridge.ts";
export {
	type AlarmKind,
	type BaseCheck,
	type BridgeAlarm,
	type BridgeHooks,
	createReconciler,
	defaultCheckBase,
	type Reconciler,
	type ReconcilerDeps,
	type SweepReport,
} from "./reconciler.ts";
