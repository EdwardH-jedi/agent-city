// Hand-written declarations for the ported engine (agent-city; see PROVENANCE.md). TownArt (people) is ported for the
// leads (S2/S3); S1 does not import it. Typed loosely until then.
export interface TownArtApi {
	readonly version: string;
	getSprite(req: Record<string, unknown>): {
		readonly width: number;
		readonly height: number;
		readonly rgba: Uint8Array;
		readonly pivotX: number;
		readonly pivotY: number;
	};
	listStyles(): unknown;
}
export declare const TownArt: TownArtApi;
