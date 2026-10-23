import type { FileSource, ShellBridge } from "../core/types";
import { AccessDeniedError } from "../core/errors";
import { nextId } from "./sources";

/** What electron/preload.cjs exposes on window.uniview. Keep in sync with the preload. */
export interface ElectronApi {
  pickFiles(): Promise<GrantedFile[]>;
  openPath(path: string): Promise<GrantedFile>;
  readRange(token: string, start: number, end: number): Promise<ArrayBuffer>;
  reveal(token: string): void;
  onOpenFiles(cb: (files: GrantedFile[]) => void): () => void;
  ready(): void;
}

export interface GrantedFile {
  token: string;
  name: string;
  path: string;
  size: number;
}

export function hasElectronApi(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { uniview?: ElectronApi }).uniview;
}

function api(): ElectronApi {
  return (window as unknown as { uniview: ElectronApi }).uniview;
}

const tokens = new WeakMap<FileSource, string>();

function toSource(f: GrantedFile): FileSource {
  const read = async (start: number, end: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await api().readRange(f.token, start, end);
    } catch (err) {
      throw new AccessDeniedError((err as Error).message);
    }
  };
  const source: FileSource = {
    id: nextId(),
    name: f.name,
    size: f.size,
    path: f.path,
    readAll: (signal) => read(0, f.size, signal),
    readRange: read,
    // Served by the main process with HTTP range support, so media streams instead of loading whole.
    url: async () => `uniview-file://${f.token}/${encodeURIComponent(f.name)}`,
    release() {},
  };
  tokens.set(source, f.token);
  return source;
}

export function createElectronBridge(): ShellBridge {
  return {
    kind: "electron",
    pickFiles: async () => (await api().pickFiles()).map(toSource),
    openPath: async (path) => toSource(await api().openPath(path)),
    onExternalOpen: (cb) => api().onOpenFiles((files) => cb(files.map(toSource))),
    revealInFolder: (source) => {
      const token = tokens.get(source);
      if (token) api().reveal(token);
    },
  };
}
