export interface IconConstants {
  viewBox: string;
  viewBoxSize: number;
  colors: {
    primary: string;
    primaryRgb: [number, number, number];
    white: string;
    monochrome: string;
  };
  geometry: {
    squircleRadius: number;
    squircleRadiusRatio: number;
    lensArcRadius: number;
    pupilRadius: number;
    pupilRadiusRatio: number;
    glintRadius: number;
    glintRadiusRatio: number;
    glintCx: number;
    glintCy: number;
  };
}

export declare const ICON_CONSTANTS: IconConstants;

export declare function encodePng(width: number, height: number, data: Buffer, colorType?: number): Buffer;
export declare function createIco(images: Array<{ width: number; height: number; buffer: Buffer }>): Buffer;
export declare function renderSquareIcon(
  size: number,
  options?: { monochrome?: boolean; fullBleed?: boolean; colorType?: number }
): Buffer;
export declare function renderRoundIcon(size: number): Buffer;
export declare function renderAdaptiveForeground(size: number): Buffer;
export declare function renderSplash(width: number, height: number): Buffer;
export declare function generateAll(): Promise<void>;
