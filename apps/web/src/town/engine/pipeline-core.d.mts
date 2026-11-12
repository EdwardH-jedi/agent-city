// Hand-written declarations for the ported engine (agent-city; see PROVENANCE.md). Only what the TypeScript side imports.
export declare const RT_W: 384;
export declare const RT_H: 288;
export interface IntegerLayout {
	scale: number;
	width: number;
	height: number;
	/** GL viewport origin, bottom-left. */
	x: number;
	y: number;
	fits: boolean;
}
export declare function chooseIntegerScale(
	winW: number,
	winH: number,
	maxScale?: number | null,
): IntegerLayout;
