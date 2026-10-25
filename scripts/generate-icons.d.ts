export interface IconJob {
  w: number;
  h: number;
  /** Longer side of the logo in px (aspect ratio preserved, centred). */
  box: number;
  white?: boolean;
  circle?: boolean;
  opaque?: boolean;
}

export interface IconPlan {
  jobs: Record<string, IconJob>;
  files: Array<{ path: string; job: string }>;
  ico: { path: string; jobs: string[] };
}

export declare const MASTER_PATH: string;
export declare const DEFAULT_PLAYWRIGHT_BROWSERS_PATH: string;
export declare const ICO_SIZES: number[];
export declare const SPLASH_LOGO_PX: number;
export declare const ADAPTIVE_SAFE_ZONE: number;
export declare const ROUND_LOGO_RATIO: number;

export declare function encodePng(width: number, height: number, rgba: Buffer, colorType?: 2 | 6): Buffer;
export declare function createIco(images: Array<{ width: number; height: number; buffer: Buffer }>): Buffer;
export declare function buildPlan(): IconPlan;
export declare function renderInPage(masterB64: string, job: IconJob): Promise<string>;
export declare function generateAll(): Promise<void>;
