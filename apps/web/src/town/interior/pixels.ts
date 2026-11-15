import {
	DataTexture,
	NearestFilter,
	RGBAFormat,
	UnsignedByteType,
} from "three";
import * as board from "../engine/leaderboard.mjs";

export interface PixelImage {
	width: number;
	height: number;
	data: Uint8Array;
}
const font = board as unknown as {
	boardText(s: string, max: number, maxW: number): string;
	drawBoardText(
		img: PixelImage,
		s: string,
		x: number,
		y: number,
		color: readonly number[],
	): number;
};
export const rgb = (n: number): [number, number, number] => [
	(n >> 16) & 255,
	(n >> 8) & 255,
	n & 255,
];
export function fill(
	img: PixelImage,
	x: number,
	y: number,
	w: number,
	h: number,
	color: readonly number[],
) {
	for (
		let yy = Math.max(0, Math.round(y));
		yy < Math.min(img.height, Math.round(y + h));
		yy++
	)
		for (
			let xx = Math.max(0, Math.round(x));
			xx < Math.min(img.width, Math.round(x + w));
			xx++
		)
			img.data.set(
				[color[0] ?? 0, color[1] ?? 0, color[2] ?? 0, 255],
				(yy * img.width + xx) * 4,
			);
}
export function letters(
	img: PixelImage,
	text: string,
	x: number,
	y: number,
	color: readonly number[],
	scale = 1,
) {
	if (scale > 1) {
		const small = {
			width: Math.floor((img.width - x) / scale),
			height: 6,
			data: new Uint8Array(Math.floor((img.width - x) / scale) * 6 * 4),
		};
		letters(small, text, 0, 0, color);
		for (let yy = 0; yy < small.height; yy++)
			for (let xx = 0; xx < small.width; xx++) {
				const i = (yy * small.width + xx) * 4;
				if (small.data[i + 3])
					fill(img, x + xx * scale, y + yy * scale, scale, scale, color);
			}
		return;
	}
	font.drawBoardText(
		img,
		font.boardText(text, 40, img.width - x - 3),
		x,
		y,
		color,
	);
}
/** Image rows are top-down; GL data rows are bottom-up, as in the existing crew atlas. */
export function upload(texture: DataTexture, img: PixelImage) {
	const data = texture.image.data as Uint8Array;
	const row = img.width * 4;
	for (let y = 0; y < img.height; y++)
		data.set(
			img.data.subarray(y * row, (y + 1) * row),
			(img.height - 1 - y) * row,
		);
	texture.needsUpdate = true;
}
export function pixelTexture(width: number, height: number): DataTexture {
	const t = new DataTexture(
		new Uint8Array(width * height * 4),
		width,
		height,
		RGBAFormat,
		UnsignedByteType,
	);
	t.magFilter = NearestFilter;
	t.minFilter = NearestFilter;
	t.generateMipmaps = false;
	return t;
}
