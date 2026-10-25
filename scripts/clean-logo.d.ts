export declare const SOURCE_PATH: string;
export declare const CLEAN_PATH: string;
export declare const FLOOD_LUMINANCE_MAX: number;
export declare const NEUTRAL_SPREAD_MAX: number;
export declare const FRAME_VALUE: number;
export declare const RING_LUMINANCE_MAX: number;
export declare const RING_PASSES: number;
export interface RgbaImage {
  width: number;
  height: number;
  rgba: Buffer;
}
export declare function decodePng(buf: Buffer): RgbaImage;
export declare function cleanLogo(img: RgbaImage): RgbaImage & { stats: { framePixels: number; ringPixels: number; crop: { x0: number; y0: number; cw: number; ch: number } } };
export declare function writeCleanLogo(): Buffer;
