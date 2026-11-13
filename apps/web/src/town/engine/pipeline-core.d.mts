// Hand-written declarations for the ported engine (agent-city; see PROVENANCE.md). Only what the TypeScript side imports.
/** agent-city: a live binding (setRenderWidth); 384 unless the town narrowed it. */
export declare let RT_W: number;
export declare const RT_W_MAX: 384;
/** Sets RT_W (1..RT_W_MAX); returns it. Cameras made later take the new aspect; existing ones must be updated. */
export declare function setRenderWidth(w: number): number;
/** agent-city: a live binding (setRenderHeight); 288 unless the town raised it to fill its column (≤ 360). */
export declare let RT_H: number;
/** Sets RT_H (288..360); returns it. Cameras made later take the new aspect; existing ones must be updated. */
export declare function setRenderHeight(h: number): number;
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
