/**
 * Pure resolution module for review receipt references on phone and web.
 * Implements LAN-shared folder path resolution, companion file matching, and one async
 * resolver (`createReferenceResolver`) that the receipt viewer uses for receipt files, the
 * receipt's view and the images/fileRefs inside that view.
 */
import { WEB_HASH_LIMITS, sha256HexWeb, type ByteBudget } from "./receipt-verify-web";

export interface LanContext {
  hostId: string;
  rootId: string;
  /** Relative path of the receipt (or the spec) within the LAN shared root, e.g. "dir/task.receipt.json" */
  receiptPath: string;
}

export type LanResolveResult =
  | { ok: true; resolvedPath: string; hostId: string; rootId: string }
  | { ok: false; reason: "missing" };

/** A file picked by the person. The handle is read lazily; the bytes are never retained. */
export interface CompanionHandle {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface CompanionFile {
  id: string;
  name: string;
  size: number;
  sha256?: string;
  handle?: CompanionHandle;
}

export type CompanionMatchResult =
  | { status: "matched"; file: CompanionFile }
  | { status: "ambiguous"; candidates: CompanionFile[] }
  | { status: "missing" };

/** A file on the LAN-shared root, read through the remote client. */
export interface LanFile {
  size: number;
  readAll(): Promise<ArrayBuffer>;
}

/** Reads files of the root the receipt was opened from. `open` rejects with LanNotFoundError when absent. */
export interface LanReader {
  open(path: string): Promise<LanFile>;
}

export class LanNotFoundError extends Error {
  constructor(message = "File not found on the shared folder") {
    super(message);
    this.name = "LanNotFoundError";
  }
}

let companionCounter = 0;
/** Companion ids are unique for the life of the page, whatever the time or batch. */
export function nextCompanionId(): string {
  companionCounter += 1;
  return `comp-${companionCounter}`;
}

export function getReceiptFolder(receiptPath: string): string {
  const norm = receiptPath.replace(/\\/g, "/");
  const lastSlash = norm.lastIndexOf("/");
  return lastSlash >= 0 ? norm.slice(0, lastSlash) : "";
}

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
/** Only dots and spaces: Windows hosts strip trailing dots and spaces, so these can act as '..' or '.'. */
const DOTS_AND_SPACES = /^[. ]+$/;

function isAbsolutePath(p: string): boolean {
  if (p.startsWith("/") || p.startsWith("\\")) return true;
  if (/^[a-zA-Z]:/.test(p)) return true;
  return false;
}

/**
 * Applies `path` to `stack` segment by segment. Returns false when the path is unsafe: it escapes the
 * root, has a control character, or has a segment that a Windows host would read as a dot segment.
 */
function walk(stack: string[], path: string): boolean {
  for (const seg of path.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (CONTROL_CHARS.test(seg)) return false;
    if (seg === "..") {
      if (stack.length === 0) return false;
      stack.pop();
      continue;
    }
    if (DOTS_AND_SPACES.test(seg)) return false;
    stack.push(seg);
  }
  return true;
}

/**
 * Resolves a reference's relPath when the receipt was opened from a LAN-shared folder.
 * Rules:
 * - Must be on the same host and root ('..' leaving the root, absolute relPath, or different root -> missing).
 * - relPath is resolved relative to the receipt's folder.
 * - Segments are never decoded; a '..' hidden behind trailing dots or spaces, NUL or control characters,
 *   and a receipt path that itself leaves the root are all missing.
 */
export function resolveLanPath(
  relPath: string | undefined,
  lanContext: LanContext | undefined,
  opts?: { targetHostId?: string; targetRootId?: string }
): LanResolveResult {
  const missing: LanResolveResult = { ok: false, reason: "missing" };
  if (!relPath || typeof relPath !== "string" || relPath.trim() === "") return missing;
  if (!lanContext) return missing;
  if (opts?.targetHostId && opts.targetHostId !== lanContext.hostId) return missing;
  if (opts?.targetRootId && opts.targetRootId !== lanContext.rootId) return missing;
  if (isAbsolutePath(relPath)) return missing;

  const stack: string[] = [];
  if (!walk(stack, getReceiptFolder(lanContext.receiptPath))) return missing;
  if (!walk(stack, relPath)) return missing;
  // The folder itself is not a file.
  if (stack.length === 0) return missing;

  return {
    ok: true,
    resolvedPath: stack.join("/"),
    hostId: lanContext.hostId,
    rootId: lanContext.rootId,
  };
}

/**
 * Matches companion files picked by the user:
 * - Matched by file name (case-insensitive)
 * - Among duplicates, matched by expected hash
 * - Still ambiguous -> returns status "ambiguous" with candidate list for user choice
 */
export function matchCompanionFile(
  targetPathOrRelPath: string,
  expectedSha256: string | undefined,
  companions: CompanionFile[]
): CompanionMatchResult {
  const candidates = companionNameCandidates(targetPathOrRelPath, companions);

  if (candidates.length === 0) {
    return { status: "missing" };
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    if (!only) return { status: "missing" };
    return { status: "matched", file: only };
  }

  // Duplicates by file name: disambiguate by hash
  if (expectedSha256) {
    const expectedLower = expectedSha256.toLowerCase();
    const hashMatches = candidates.filter(
      (c) => c.sha256 && c.sha256.toLowerCase() === expectedLower
    );
    if (hashMatches.length === 1) {
      const match = hashMatches[0];
      if (!match) return { status: "missing" };
      return { status: "matched", file: match };
    }
  }

  // Still ambiguous -> the person chooses
  return { status: "ambiguous", candidates };
}

/** The picked files whose name equals the last segment of the reference. */
export function companionNameCandidates(
  targetPathOrRelPath: string,
  companions: CompanionFile[]
): CompanionFile[] {
  const norm = targetPathOrRelPath.replace(/\\/g, "/");
  const targetName = (norm.split("/").pop() ?? "").toLowerCase();
  if (!targetName) return [];
  return companions.filter((c) => c.name.toLowerCase() === targetName);
}

// ---------------------------------------------------------------------------------------------------------
// One resolver for every reference kind.
// ---------------------------------------------------------------------------------------------------------

export interface ReferenceInput {
  /** Identifies the reference for "the person chose this file" (e.g. "file:3", "view"). */
  key: string;
  path: string;
  relPath?: string;
  sha256?: string;
}

export type ResolvedTarget = {
  via: "lan" | "companion";
  /** Companion id, or the path on the share: stable while the same file is resolved. */
  id: string;
  name: string;
  size: number;
  read(): Promise<ArrayBuffer>;
  /** Set when this pass already hashed the file to pick it among duplicates. */
  digestHex?: () => Promise<string>;
  /** The bytes of `digestHex` are already charged to the pass budget. */
  prehashed?: boolean;
};

export type ResolveOutcome =
  | ({ status: "found" } & ResolvedTarget)
  | { status: "missing" }
  | { status: "ambiguous"; candidates: CompanionFile[] };

export interface ResolverDeps {
  lan?: LanContext;
  lanReader?: LanReader | null;
  companions: CompanionFile[];
  /** References where the person chose among ambiguous candidates, by ReferenceInput.key. */
  chosen?: Record<string, CompanionFile>;
  /** Hashes of picked files computed so far (they never change), by companion id. */
  hashCache?: Map<string, string | null>;
  budget: ByteBudget;
  signal?: AbortSignal;
}

function companionTarget(c: CompanionFile): ResolvedTarget {
  const handle = c.handle;
  return {
    via: "companion",
    id: c.id,
    name: c.name,
    size: handle ? handle.size : c.size,
    read: async () => {
      if (!handle) throw new Error("Companion file is not readable");
      return handle.arrayBuffer();
    },
  };
}

/**
 * Creates the resolver for one pass. Rules:
 * - Opened from a LAN folder and the reference has a relPath: resolved on that host and root only. An
 *   escaping, absolute or otherwise unsafe relPath is `missing` and never falls through to companions;
 *   a file absent on the share is `missing`; a failed read rejects (the caller reports `unreadable`).
 * - Otherwise: picked companions by file name; duplicates are told apart by hash (hashed one at a time,
 *   <= 256 MiB each, charged to the per-receipt budget); still ambiguous -> the person chooses.
 */
export function createReferenceResolver(deps: ResolverDeps) {
  const charged = new Set<string>();
  const hashCache = deps.hashCache ?? new Map<string, string | null>();

  async function hashCandidate(c: CompanionFile): Promise<string | undefined> {
    if (!c.handle) return undefined;
    const size = c.handle.size;
    if (size > WEB_HASH_LIMITS.MAX_FILE_BYTES) return undefined;
    if (!charged.has(c.id)) {
      if (deps.budget.used + size > WEB_HASH_LIMITS.MAX_RECEIPT_BYTES) return undefined;
      deps.budget.used += size;
      charged.add(c.id);
    }
    const cached = hashCache.get(c.id);
    if (cached !== undefined) return cached ?? undefined;
    if (deps.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const sha = await sha256HexWeb(await c.handle.arrayBuffer());
      hashCache.set(c.id, sha);
      return sha;
    } catch {
      hashCache.set(c.id, null);
      return undefined;
    }
  }

  return async function resolve(ref: ReferenceInput, lanBasePath?: string): Promise<ResolveOutcome> {
    const picked = deps.chosen?.[ref.key];
    if (picked) return { status: "found", ...companionTarget(picked) };

    if (deps.lan && ref.relPath) {
      const lan = resolveLanPath(ref.relPath, {
        ...deps.lan,
        receiptPath: lanBasePath ?? deps.lan.receiptPath,
      });
      if (!lan.ok) return { status: "missing" };
      if (!deps.lanReader) throw new Error("The shared folder cannot be read from this device");
      try {
        const file = await deps.lanReader.open(lan.resolvedPath);
        return {
          status: "found",
          via: "lan",
          id: lan.resolvedPath,
          name: lan.resolvedPath.split("/").pop() ?? lan.resolvedPath,
          size: file.size,
          read: () => file.readAll(),
        };
      } catch (err) {
        if (err instanceof LanNotFoundError) return { status: "missing" };
        throw err;
      }
    }

    const namePath = ref.relPath || ref.path;
    const named = companionNameCandidates(namePath, deps.companions);
    if (named.length > 1 && ref.sha256) {
      for (const c of named) await hashCandidate(c);
    }
    // Copies carry the hashes found for duplicates; the picked files themselves are never changed.
    const withHashes = deps.companions.map((c) => {
      const h = charged.has(c.id) ? hashCache.get(c.id) : undefined;
      return h ? { ...c, sha256: h } : c;
    });
    const match = matchCompanionFile(namePath, ref.sha256, withHashes);
    if (match.status === "matched") {
      const target = companionTarget(match.file);
      const sha = match.file.sha256;
      if (named.length > 1 && sha && charged.has(match.file.id)) {
        target.digestHex = async () => sha;
        target.prehashed = true;
      }
      return { status: "found", ...target };
    }
    if (match.status === "ambiguous") return { status: "ambiguous", candidates: match.candidates };
    return { status: "missing" };
  };
}
