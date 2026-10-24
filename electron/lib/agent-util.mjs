// Small helpers shared by the agent persistence modules (activity log, enrollment store). Plain Node ESM, fs injected.

import crypto from "node:crypto";
import path from "node:path";

/** Control characters and bidirectional marks/overrides: agent-supplied labels never keep them. */
// eslint-disable-next-line no-control-regex
const UNSAFE_LABEL_CHARS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/** An untrusted display label: control and bidi characters removed, at most `max` characters. */
export function cleanLabel(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(UNSAFE_LABEL_CHARS, "").slice(0, max);
}

/**
 * Writes `data` to `file` through a temp file in the same folder and a rename, so readers see the old or the
 * new content, never a partial file. The temp file is created exclusively with `mode` (owner-only by default).
 */
export async function writeFileAtomic(fs, file, data, { mode = 0o600 } = {}) {
  const temp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${crypto.randomBytes(6).toString("hex")}`);
  try {
    await fs.writeFile(temp, data, { flag: "wx", mode });
    await fs.rename(temp, file);
  } catch (err) {
    try {
      await fs.unlink(temp);
    } catch {}
    throw err;
  }
}

/** Parsed JSON from `file`, or `fallback` when the file is missing or is not valid JSON. */
export async function readJsonFile(fs, file, fallback) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
