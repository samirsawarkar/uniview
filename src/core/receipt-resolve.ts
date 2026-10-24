/**
 * Pure resolution module for review receipt references on phone and web.
 * Implements LAN-shared folder path resolution and companion file matching.
 */

export interface LanContext {
  hostId: string;
  rootId: string;
  /** Relative path of the receipt within the LAN shared root, e.g. "dir/task.receipt.json" */
  receiptPath: string;
}

export type LanResolveResult =
  | { ok: true; resolvedPath: string; hostId: string; rootId: string }
  | { ok: false; reason: "missing" };

export interface CompanionFile {
  id: string;
  name: string;
  size: number;
  sha256?: string;
  data?: ArrayBuffer | Uint8Array;
}

export type CompanionMatchResult =
  | { status: "matched"; file: CompanionFile }
  | { status: "ambiguous"; candidates: CompanionFile[] }
  | { status: "missing" };

export interface ReferenceInput {
  kind: "file" | "image" | "fileRef" | "view";
  path: string;
  relPath?: string;
  sha256?: string;
}

export interface ResolvedReference {
  kind: "file" | "image" | "fileRef" | "view";
  resolved: boolean;
  resolvedPath?: string;
  placeholder?: string;
  disabled?: boolean;
  match?: CompanionFile;
}

export function getReceiptFolder(receiptPath: string): string {
  const norm = receiptPath.replace(/\\/g, "/");
  const lastSlash = norm.lastIndexOf("/");
  return lastSlash >= 0 ? norm.slice(0, lastSlash) : "";
}

function isAbsolutePath(p: string): boolean {
  if (p.startsWith("/") || p.startsWith("\\")) return true;
  if (/^[a-zA-Z]:/.test(p)) return true;
  if (p.startsWith("//") || p.startsWith("\\\\")) return true;
  return false;
}

/**
 * Resolves a reference's relPath when the receipt was opened from a LAN-shared folder.
 * Rules:
 * - Must be on the same host and root ('..' leaving the root, absolute relPath, or different root -> missing).
 * - relPath is resolved relative to the receipt's folder.
 */
export function resolveLanPath(
  relPath: string | undefined,
  lanContext: LanContext | undefined,
  opts?: { targetHostId?: string; targetRootId?: string }
): LanResolveResult {
  if (!relPath || typeof relPath !== "string" || relPath.trim() === "") {
    return { ok: false, reason: "missing" };
  }
  if (!lanContext) {
    return { ok: false, reason: "missing" };
  }
  if (opts?.targetHostId && opts.targetHostId !== lanContext.hostId) {
    return { ok: false, reason: "missing" };
  }
  if (opts?.targetRootId && opts.targetRootId !== lanContext.rootId) {
    return { ok: false, reason: "missing" };
  }
  if (isAbsolutePath(relPath)) {
    return { ok: false, reason: "missing" };
  }

  const receiptFolder = getReceiptFolder(lanContext.receiptPath);
  const stack = receiptFolder ? receiptFolder.split("/").filter(Boolean) : [];
  const segments = relPath.split(/[\\/]/);

  for (const seg of segments) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (stack.length === 0) {
        // Escapes the shared root -> missing, never followed
        return { ok: false, reason: "missing" };
      }
      stack.pop();
    } else {
      stack.push(seg);
    }
  }

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
  const norm = targetPathOrRelPath.replace(/\\/g, "/");
  const targetName = (norm.split("/").pop() ?? "").toLowerCase();
  if (!targetName) return { status: "missing" };

  const candidates = companions.filter(
    (c) => c.name.toLowerCase() === targetName
  );

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

/**
 * Resolves references (files, images, fileRefs, view specs) for phone and web.
 * - Unresolved images show placeholder 'image not available on this device'.
 * - Unresolved fileRefs are disabled.
 */
export function resolveReference(
  ref: ReferenceInput,
  lanContext?: LanContext,
  companions?: CompanionFile[]
): ResolvedReference {
  if (lanContext && ref.relPath) {
    const lan = resolveLanPath(ref.relPath, lanContext);
    if (lan.ok) {
      return {
        kind: ref.kind,
        resolved: true,
        resolvedPath: lan.resolvedPath,
        disabled: false,
      };
    }
  }

  if (companions && companions.length > 0) {
    const matchPath = ref.relPath || ref.path;
    const comp = matchCompanionFile(matchPath, ref.sha256, companions);
    if (comp.status === "matched") {
      return {
        kind: ref.kind,
        resolved: true,
        match: comp.file,
        resolvedPath: comp.file.name,
        disabled: false,
      };
    }
  }

  // Unresolved reference handling
  if (ref.kind === "image") {
    return {
      kind: "image",
      resolved: false,
      placeholder: "image not available on this device",
    };
  }

  if (ref.kind === "fileRef") {
    return {
      kind: "fileRef",
      resolved: false,
      disabled: true,
    };
  }

  return {
    kind: ref.kind,
    resolved: false,
    disabled: true,
  };
}
