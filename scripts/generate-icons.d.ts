export declare function encodePng(width: number, height: number, rgba: Buffer): Buffer;
export declare function createIco(images: Array<{ width: number; height: number; buffer: Buffer }>): Buffer;
export declare function renderSquareIcon(size: number, options?: { monochrome?: boolean }): Buffer;
export declare function renderRoundIcon(size: number): Buffer;
export declare function renderAdaptiveForeground(size: number): Buffer;
export declare function renderSplash(width: number, height: number): Buffer;
export declare function generateAll(): Promise<void>;
