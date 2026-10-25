import path from "node:path";
import defaultFs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
// @ts-expect-error plain ESM module without types
import { validateDecision } from "../../shared/receipt.mjs";

// Errors that mean "this filesystem cannot make hard links"; the exclusive copy is used instead.
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EINVAL", "EMLINK"]);

function tempNameFor(dir, base) {
  return path.join(dir, `.tmp-${base}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
}

/** Writes `text` to a brand-new temp file (flag wx) and flushes it to disk before returning. */
async function writeTempDurably(fs, tempPath, text) {
  const handle = await fs.open(tempPath, "wx");
  try {
    await handle.writeFile(text, "utf8");
    if (typeof handle.sync === "function") await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Creates `targetPath` with `text` only if nothing is there yet, and never overwrites.
 * The content is written to a temp file first and then hard-linked into place, so the target
 * either does not exist or is complete. Resolves "created" or "exists"; any other failure throws.
 */
async function createExclusive(fs, targetPath, text) {
  const tempPath = tempNameFor(path.dirname(targetPath), path.basename(targetPath));
  try {
    // Inside the try so a failed write or flush (ENOSPC, EIO) still removes the partial temp file.
    await writeTempDurably(fs, tempPath, text);
    try {
      await fs.link(tempPath, targetPath);
      return "created";
    } catch (err) {
      if (err?.code === "EEXIST") return "exists";
      if (!LINK_UNSUPPORTED.has(err?.code)) throw err;
    }
    try {
      await fs.copyFile(tempPath, targetPath, fsConstants.COPYFILE_EXCL);
      return "created";
    } catch (err) {
      if (err?.code === "EEXIST") return "exists";
      throw err;
    }
  } finally {
    try {
      await fs.unlink(tempPath);
    } catch {}
  }
}

export const STORE_DEFAULTS = Object.freeze({ max: 500, ttlDays: 30, staleTempMs: 10 * 60 * 1000 });

export function createDecisionStore({
  dir,
  fs = defaultFs,
  now = Date.now,
  max = STORE_DEFAULTS.max,
  ttlDays = STORE_DEFAULTS.ttlDays,
  staleTempMs = STORE_DEFAULTS.staleTempMs,
}) {
  const knownIds = new Set();
  // In-memory claims taken synchronously by decide(): one decision per review per store.
  const claims = new Set();

  async function hasDecision(reviewId) {
    if (knownIds.has(reviewId)) return true;
    try {
      await fs.access(path.join(dir, `${reviewId}.json`));
      return true;
    } catch (err) {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return false;
      // Cannot tell: fail closed rather than let a second decision through.
      throw err;
    }
  }

  async function prune() {
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }

    const currentTime = now();
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    const cutoffTime = currentTime - ttlMs;
    const remaining = [];

    for (const entry of entries) {
      // Leftover temp files from a crashed or failed write: removed once older than staleTempMs.
      // Only this store directory is ever swept, never a project folder.
      if (entry.startsWith(".tmp-") && entry.endsWith(".tmp")) {
        const tempFile = path.join(dir, entry);
        try {
          const st = await fs.stat(tempFile);
          if (currentTime - st.mtimeMs > staleTempMs) await fs.unlink(tempFile);
        } catch {}
        continue;
      }
      if (!entry.endsWith(".json") || entry.endsWith(".tmp") || entry.endsWith(".decision.json")) {
        continue;
      }

      const filePath = path.join(dir, entry);
      let fileData = null;
      try {
        const raw = await fs.readFile(filePath, "utf8");
        fileData = JSON.parse(raw);
      } catch {
        continue;
      }

      const reviewId = fileData?.reviewId ?? entry.replace(/\.json$/, "");
      const entryTime = fileData?.decidedAt ? new Date(fileData.decidedAt).getTime() : currentTime;

      if (entryTime < cutoffTime) {
        try {
          await fs.unlink(filePath);
        } catch {}
        knownIds.delete(reviewId);
      } else {
        remaining.push({
          reviewId,
          filePath,
          time: entryTime,
        });
      }
    }

    if (remaining.length > max) {
      remaining.sort((a, b) => a.time - b.time);
      const toDrop = remaining.length - max;
      for (let i = 0; i < toDrop; i++) {
        try {
          await fs.unlink(remaining[i].filePath);
        } catch {}
        knownIds.delete(remaining[i].reviewId);
      }
    }
  }

  /** Creates the record exclusively. Rejects with code EEXIST when the review already has one. */
  async function save(decision) {
    await fs.mkdir(dir, { recursive: true });
    const targetPath = path.join(dir, `${decision.reviewId}.json`);
    const outcome = await createExclusive(fs, targetPath, JSON.stringify(decision, null, 2));
    if (outcome === "exists") {
      knownIds.add(decision.reviewId);
      throw Object.assign(new Error(`Decision for review ${decision.reviewId} already exists`), { code: "EEXIST" });
    }

    knownIds.add(decision.reviewId);
    try {
      await prune();
    } catch {
      // Retention is housekeeping; the record itself is safely on disk.
    }
  }

  /** Atomically replaces this review's own existing record (used to correct `persisted`). */
  async function rewrite(decision) {
    const targetPath = path.join(dir, `${decision.reviewId}.json`);
    const existing = JSON.parse(await fs.readFile(targetPath, "utf8"));
    if (!existing || existing.reviewId !== decision.reviewId) {
      throw Object.assign(new Error("Existing record belongs to another review"), { code: "EEXIST" });
    }
    const tempPath = tempNameFor(dir, path.basename(targetPath));
    try {
      await writeTempDurably(fs, tempPath, JSON.stringify(decision, null, 2));
      await fs.rename(tempPath, targetPath);
    } catch (err) {
      try {
        await fs.unlink(tempPath);
      } catch {}
      throw err;
    }
  }

  /** Deletes this review's record (best effort cleanup when it can no longer be corrected). */
  async function remove(reviewId) {
    await fs.unlink(path.join(dir, `${reviewId}.json`));
    knownIds.delete(reviewId);
  }

  async function load(reviewId) {
    const targetPath = path.join(dir, `${reviewId}.json`);
    try {
      const content = await fs.readFile(targetPath, "utf8");
      const parsed = JSON.parse(content);
      knownIds.add(reviewId);
      return parsed;
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  return {
    fs,
    claims,
    limits: { max, ttlDays, staleTempMs },
    hasDecision,
    save,
    rewrite,
    remove,
    load,
    prune,
  };
}

/**
 * Normal form used to compare a directory with its realpath. On Windows it is case-insensitive and a
 * native-style prefix is dropped (extended-length drive form becomes the plain drive path, the UNC form
 * becomes a plain UNC path), so a realpath result in that form never makes a normal directory look linked.
 */
export function comparablePath(p, platform = process.platform) {
  const resolved = path.resolve(p);
  if (platform !== "win32") return resolved;
  let s = resolved;
  if (/^\\\\[?.]\\UNC\\/i.test(s)) s = "\\\\" + s.slice(8);
  else if (/^\\\\[?.]\\/.test(s)) s = s.slice(4);
  return s.toLowerCase();
}

/** True when no component of `dir` is a symlink or junction (realpath equals the resolved path). */
async function parentIsLinkFree(fs, dir) {
  try {
    const real = await fs.realpath(dir);
    return comparablePath(real) === comparablePath(dir);
  } catch {
    return false;
  }
}

/**
 * After the write: the directory and the target must still resolve to exactly where they were checked.
 *
 * Node has no directory-relative file operations on Windows, so the writes above go through the pathname
 * and an ancestor swapped to a junction/symlink after the first realpath could redirect them. This second
 * check turns that into a detected failure: the caller removes what it created and reports false.
 * Residual window: a swap that is undone again before this check cannot be seen without handle-relative
 * operations; the data then still went to the intended directory or was removed again.
 */
async function placementStillValid(fs, dir, targetPath) {
  try {
    if (!(await parentIsLinkFree(fs, dir))) return false;
    const realTarget = await fs.realpath(targetPath);
    return comparablePath(realTarget) === comparablePath(targetPath);
  } catch {
    return false;
  }
}

function isDecisionEqual(a, b) {
  if (!a || !b) return false;
  if (a.reviewId !== b.reviewId) return false;
  if (a.receiptDigest !== b.receiptDigest) return false;
  if (a.decision !== b.decision) return false;
  if ((a.comment ?? "") !== (b.comment ?? "")) return false;
  if (a.decidedAt !== b.decidedAt) return false;
  if (a.verifiedAt !== b.verifiedAt) return false;

  if (!Array.isArray(a.files) || !Array.isArray(b.files)) return false;
  if (a.files.length !== b.files.length) return false;

  for (let i = 0; i < a.files.length; i++) {
    const af = a.files[i];
    const bf = b.files[i];
    if (!af || !bf) return false;
    if (af.path !== bf.path) return false;
    if (af.expectedSha256 !== bf.expectedSha256) return false;
    if ((af.observedSha256 ?? null) !== (bf.observedSha256 ?? null)) return false;
    if (af.state !== bf.state) return false;
  }

  return true;
}

/**
 * Writes `<receipt>.decision.json` next to the receipt. Never overwrites another review's decision:
 * the file is created atomically only if absent. Resolves true when this review's decision is there.
 */
export async function writeDecisionNextToReceipt(receiptPath, decision, { fs = defaultFs, outcome: outcomeOut = null } = {}) {
  if (!receiptPath || receiptPath === null || !decision) {
    return false;
  }

  try {
    const resolvedReceipt = path.resolve(receiptPath);
    const targetPath = `${resolvedReceipt}.decision.json`;
    const dir = path.dirname(targetPath);

    if (!(await parentIsLinkFree(fs, dir))) {
      return false;
    }

    // A pre-existing symlink is refused outright; the exclusive create below is what closes the race.
    let stats;
    try {
      stats = await fs.lstat(targetPath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        return false;
      }
    }
    if (stats?.isSymbolicLink()) {
      return false;
    }

    const outcome = await createExclusive(fs, targetPath, JSON.stringify(decision, null, 2));
    if (outcome === "created") {
      if (await placementStillValid(fs, dir, targetPath)) return true;
      // Post-create placement/ancestor verification failed: never unlink targetPath by pathname
      // (a redirected pathname could delete another review's file). Leave harmless decision text,
      // return persisted:false with sidecar_unverified note. Only the temp file was unlinked by createExclusive.
      if (outcomeOut) {
        outcomeOut.note = "sidecar_unverified";
      }
      return false;
    }

    // Something is already there: fine only if it is this review's own decision.
    if (!(await placementStillValid(fs, dir, targetPath))) {
      if (outcomeOut) outcomeOut.note = "sidecar_unverified";
      return false;
    }
    const existingStats = await fs.lstat(targetPath);
    if (existingStats.isSymbolicLink()) {
      if (outcomeOut) outcomeOut.note = "sidecar_conflict";
      return false;
    }

    let existing;
    try {
      const raw = await fs.readFile(targetPath, "utf8");
      existing = JSON.parse(raw);
    } catch {
      if (outcomeOut) outcomeOut.note = "sidecar_conflict";
      return false;
    }

    if (outcomeOut) {
      const validation = await validateDecision(existing);
      if (!validation.ok) {
        outcomeOut.note = "sidecar_conflict";
        return false;
      }

      if (!isDecisionEqual(validation.decision, decision)) {
        outcomeOut.note = "sidecar_conflict";
        return false;
      }

      return true;
    }

    return Boolean(existing) && existing.reviewId === decision.reviewId;
  } catch {
    return false;
  }
}
