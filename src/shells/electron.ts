import type { FileSource, RemoteTransport, ShareApi, ShellBridge } from "../core/types";
import type { Receipt, Decision, FileState } from "../../shared/receipt.d.mts";
import { AccessDeniedError } from "../core/errors";
import { nextId } from "./sources";

/**
 * A receipt is named by the opaque grant token of a file the person opened (see grantTokenOf); main resolves
 * it to a path itself. The renderer never sends a path. `receiptBytes` is for receipts that have no file.
 */
export interface ReviewOpenParams {
  receiptToken?: string;
  receiptBytes?: Uint8Array;
}

/** A validation problem in a receipt, as main reports it: fixed wording, never file content. */
export interface ReviewValidationError {
  code: string;
  path: string;
  message: string;
}

export interface ReviewOpenResult {
  ok: boolean;
  reviewId?: string;
  receiptDigest?: string;
  receipt?: Receipt;
  files?: Array<{ path: string; expectedSha256: string; observedSha256: string | null; state: FileState }>;
  verifiedAt?: string;
  error?: string;
  code?: string;
  errors?: ReviewValidationError[];
}

export interface ReviewDecideParams {
  reviewId: string;
  decision: "approved" | "changes_requested";
  comment?: string;
}

export interface ReviewDecideResult {
  ok: boolean;
  decision?: Decision;
  code?: string;
  message?: string;
  current?: Array<{ path: string; expectedSha256: string; observedSha256: string | null; state: FileState }>;
  verifiedAt?: string;
  error?: string;
  sidecarConflict?: boolean;
}

export interface ReviewApi {
  open(params: ReviewOpenParams): Promise<ReviewOpenResult>;
  decide(params: ReviewDecideParams): Promise<ReviewDecideResult>;
  dismiss(reviewId: string): Promise<{ ok: boolean; dismissed?: boolean; error?: string }>;
  refresh(reviewId: string): Promise<{ ok: boolean; files?: Array<{ path: string; expectedSha256: string; observedSha256: string | null; state: FileState }>; verifiedAt?: string; error?: string }>;
}

export interface AgentSessionInfo {
  sessionId: string;
  kind: string;
  client: { name: string; version: string };
  approval: string;
  clientId: string | null;
  openedAt: string;
  pendingReviews: number;
  openTabs?: number;
}

export interface EnrolledClientInfo {
  clientId: string;
  name: string;
  enrolledAt: string;
}

export interface AgentActivityEntry {
  at: string;
  type: string;
  sessionId?: string;
  client?: string;
  detail?: string;
}

export interface AgentsListResult {
  ok: boolean;
  sessions?: AgentSessionInfo[];
  clients?: EnrolledClientInfo[];
  enrolledClients?: EnrolledClientInfo[];
  activity?: AgentActivityEntry[];
  error?: string;
  code?: string;
}

export interface AgentsRevokeParams {
  clientId: string;
}

export interface AgentsRevokeResult {
  ok: boolean;
  removed?: boolean;
  sessionsClosed?: number;
  error?: string;
  code?: string;
}

export interface AgentsActivityParams {
  limit?: number;
}

export interface AgentsActivityResult {
  ok: boolean;
  activity?: AgentActivityEntry[];
  error?: string;
  code?: string;
}

export interface AgentsApi {
  list(): Promise<AgentsListResult>;
  revoke(params: string | AgentsRevokeParams): Promise<AgentsRevokeResult>;
  activity(params?: number | AgentsActivityParams): Promise<AgentsActivityResult>;
}

/** What electron/preload.cjs exposes on window.uniview. Keep in sync with the preload. */
export interface ElectronApi {
  pickFiles(): Promise<GrantedFile[]>;
  openPath(path: string): Promise<GrantedFile>;
  readRange(token: string, start: number, end: number, scopeId?: string): Promise<ArrayBuffer>;
  reveal(token: string): void;
  onOpenFiles(cb: (files: GrantedFile[]) => void): () => void;
  ready(): void;
  tabClosed?(scopeId: string): void;
  thumbnail(token: string, size: number): Promise<Uint8Array | null>;
  share: ShareApi;
  remotePost(host: string, port: number, path: string, body: Uint8Array, type: string, timeoutMs?: number): Promise<{ status: number; body: Uint8Array }>;
  review?: ReviewApi;
  agents?: AgentsApi;
}

export interface GrantedFile {
  token: string;
  name: string;
  path: string;
  size: number;
  scopeId?: string;
}

export function hasElectronApi(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { uniview?: ElectronApi }).uniview;
}

function api(): ElectronApi {
  return (window as unknown as { uniview: ElectronApi }).uniview;
}

const tokens = new WeakMap<FileSource, string>();

/** The grant token of a file the person opened on this computer; undefined for any other source. */
export function grantTokenOf(source: FileSource): string | undefined {
  return tokens.get(source);
}

/** Associates a grant token with a file source (e.g. in tests or when creating from a granted file). */
export function attachGrantToken(source: FileSource, token: string): void {
  tokens.set(source, token);
}

function toSource(f: GrantedFile): FileSource {
  const read = async (start: number, end: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await api().readRange(f.token, start, end, f.scopeId);
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
    url: async () =>
      f.scopeId
        ? `uniview-file://${f.token}/${encodeURIComponent(f.name)}?scope=${encodeURIComponent(f.scopeId)}`
        : `uniview-file://${f.token}/${encodeURIComponent(f.name)}`,
    release() {
      if (f.scopeId && hasElectronApi()) {
        try {
          api().tabClosed?.(f.scopeId);
        } catch {}
      }
    },
    reopen: async () => toSource(await api().openPath(f.path)),
  };
  tokens.set(source, f.token);
  return source;
}

export function createElectronBridge(): ShellBridge {
  const remoteTransport: RemoteTransport = (host, port, path, body, type, opts) => api().remotePost(host, port, path, body, type, opts?.timeoutMs);
  return {
    kind: "electron",
    remoteTransport,
    share: api().share,
    agents: api().agents,
    canScanQr: false,
    thumbnail: async (source, size) => {
      const token = tokens.get(source);
      if (!token) return null;
      const png = await api().thumbnail(token, size).catch(() => null);
      return png ? new Blob([png as BlobPart], { type: "image/png" }) : null;
    },
    pickFiles: async () => (await api().pickFiles()).map(toSource),
    openPath: async (path) => toSource(await api().openPath(path)),
    onExternalOpen: (cb) => api().onOpenFiles((files) => cb(files.map(toSource))),
    revealInFolder: (source) => {
      const token = tokens.get(source);
      if (token) api().reveal(token);
    },
  };
}
