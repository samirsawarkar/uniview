/** A file the user opened. Shells create these; viewers only read through them. */
export interface FileSource {
  id: string;
  name: string;
  /** Size in bytes, or -1 when unknown. */
  size: number;
  mimeHint?: string;
  /** Absolute desktop path, when the shell has one. */
  path?: string;
  readAll(signal?: AbortSignal): Promise<ArrayBuffer>;
  /** Bytes in [start, end). */
  readRange(start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer>;
  /** A URL media elements can stream from (blob: or uniview-file:). */
  url(): Promise<string>;
  release(): void;
}

export interface ShellBridge {
  kind: "web" | "electron" | "capacitor";
  pickFiles(): Promise<FileSource[]>;
  openPath?(path: string): Promise<FileSource>;
  onExternalOpen(cb: (files: FileSource[]) => void): () => void;
  revealInFolder?(source: FileSource): void;
}

export type FormatKind =
  | "pdf"
  | "image"
  | "tiff"
  | "video"
  | "audio"
  | "docx"
  | "sheet"
  | "pptx"
  | "epub"
  | "zip"
  | "markdown"
  | "json"
  | "text"
  | "font"
  | "legacy-office"
  | "binary";

export interface Detection {
  kind: FormatKind;
  /** Finer label shown to the user, e.g. "PNG image" or "Excel workbook". */
  label: string;
  /** Lower-case extension without the dot, or "". */
  ext: string;
  /** Highlight.js language for text and code, when known. */
  language?: string;
  /** How detection decided: signature beats container beats extension beats content. */
  by: "signature" | "container" | "extension" | "content";
}
