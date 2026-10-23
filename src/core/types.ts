/** A file the user opened. Shells create these; viewers only read through them. */
export interface FileSource {
  id: string;
  name: string;
  /** Size in bytes, or -1 when unknown. */
  size: number;
  mimeHint?: string;
  /** Absolute desktop path, when the shell has one. */
  path?: string;
  /** Remote file reference when opened from a paired computer. */
  remote?: {
    hostId: string;
    rootId: string;
    rootName: string;
    path: string;
    mtime: number;
  };
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
  onExternalOpenError?(cb: (message: string) => void): () => void;
  revealInFolder?(source: FileSource): void;
  /** An OS thumbnail for a local file, when the platform has a thumbnailer. */
  thumbnail?(source: FileSource, size: number): Promise<Blob | null>;
  /** LAN transport to another computer's sharing service; absent where remote browsing is unavailable. */
  remoteTransport?: RemoteTransport;
  /** Sharing this computer with paired devices (desktop only). */
  share?: ShareApi;
  /** Whether a camera can be used to scan pairing QR codes. */
  canScanQr?: boolean;
}

export type RemoteTransport = (
  host: string,
  port: number,
  path: string,
  body: Uint8Array,
  contentType: string,
) => Promise<{ status: number; body: Uint8Array }>;

export interface SharedRoot {
  id: string;
  name: string;
  path: string;
}

export interface TrustedDevice {
  id: string;
  name: string;
  addedAt: number;
  lastSeen: number;
  connected: boolean;
}

export interface AccessLogEntry {
  at: number;
  device: string;
  action: string;
  path: string;
}

export interface ShareState {
  enabled: boolean;
  listening: boolean;
  port: number;
  addresses: string[];
  hostName: string;
  roots: SharedRoot[];
  devices: TrustedDevice[];
  offer: { text: string; expiresAt: number } | null;
  log: AccessLogEntry[];
}

export interface ShareApi {
  state(): Promise<ShareState>;
  setEnabled(on: boolean): Promise<ShareState>;
  /** Native folder picker. Returns the chosen path, or null when cancelled. */
  pickFolder(): Promise<string | null>;
  syncthing(): Promise<{ found: boolean; folders: { label: string; path: string }[] }>;
  /** Share a folder the user just picked (after the permission screen). */
  addRoot(path: string, name?: string): Promise<ShareState>;
  removeRoot(id: string): Promise<ShareState>;
  removeDevice(id: string): Promise<ShareState>;
  offer(): Promise<{ text: string; expiresAt: number }>;
  cancelOffer(): Promise<ShareState>;
  onChanged(cb: (state: ShareState) => void): () => void;
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
