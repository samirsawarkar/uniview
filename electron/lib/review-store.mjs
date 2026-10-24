import path from "node:path";
import defaultFs from "node:fs/promises";

export function createDecisionStore({ dir, fs = defaultFs, now = Date.now, max = 500, ttlDays = 30 }) {
  const knownIds = new Set();

  function hasDecision(reviewId) {
    if (knownIds.has(reviewId)) return true;
    try {
      if (typeof fs.existsSync === "function") {
        return fs.existsSync(path.join(dir, `${reviewId}.json`));
      }
    } catch {}
    return false;
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

  async function save(decision) {
    await fs.mkdir(dir, { recursive: true });
    const targetPath = path.join(dir, `${decision.reviewId}.json`);
    const tempPath = path.join(
      dir,
      `${decision.reviewId}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    );

    await fs.writeFile(tempPath, JSON.stringify(decision, null, 2), "utf8");
    try {
      await fs.rename(tempPath, targetPath);
    } catch (err) {
      try {
        await fs.unlink(tempPath);
      } catch {}
      throw err;
    }

    knownIds.add(decision.reviewId);
    await prune();
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
    hasDecision,
    save,
    load,
    prune,
  };
}

export async function writeDecisionNextToReceipt(receiptPath, decision, { fs = defaultFs } = {}) {
  if (!receiptPath || receiptPath === null || !decision) {
    return false;
  }

  const targetPath = `${receiptPath}.decision.json`;

  try {
    let stats;
    try {
      stats = await fs.lstat(targetPath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        return false;
      }
    }

    if (stats) {
      if (stats.isSymbolicLink()) {
        return false;
      }
      let existing;
      try {
        const raw = await fs.readFile(targetPath, "utf8");
        existing = JSON.parse(raw);
      } catch {
        return false;
      }
      if (!existing || existing.reviewId !== decision.reviewId) {
        return false;
      }
    }

    const dir = path.dirname(targetPath);
    const tempPath = path.join(
      dir,
      `.tmp-${path.basename(targetPath)}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
    );

    await fs.writeFile(tempPath, JSON.stringify(decision, null, 2), "utf8");
    try {
      await fs.rename(tempPath, targetPath);
    } catch {
      try {
        await fs.unlink(tempPath);
      } catch {}
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
