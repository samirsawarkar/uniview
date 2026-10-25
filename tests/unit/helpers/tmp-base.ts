import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Base directory for test scratch files.
 *
 * The developer machine keeps scratch data on the shared I: drive (I:/AES/tmp). CI runners and
 * other machines have no such drive, so they fall back to the OS temp directory. The drive is
 * only used when its parent folder (I:/AES) really exists, and the tmp folder is created on
 * demand so callers can rely on the returned directory existing.
 *
 * Paths are written with forward slashes and normalised, so no backslash escapes are needed.
 */
const AES_ROOT = path.win32.normalize("I:/AES");
const AES_TMP = path.win32.normalize("I:/AES/tmp");

export function tmpBase(): string {
  if (process.platform === "win32" && fs.existsSync(AES_ROOT)) {
    try {
      fs.mkdirSync(AES_TMP, { recursive: true });
      return AES_TMP;
    } catch {
      // read-only or otherwise unusable: fall through to the OS temp directory
    }
  }
  return canonicalTmpdir();
}

/** Scratch root for tests that previously used the AES folder itself rather than its tmp child. */
export function aesRoot(): string {
  if (process.platform === "win32" && fs.existsSync(AES_ROOT)) return AES_ROOT;
  return canonicalTmpdir();
}

/**
 * os.tmpdir() in its canonical (long-name) form. On GitHub Actions Windows runners it is the 8.3
 * short name (C:/Users/RUNNER~1/...), while the product (correctly) works with canonical paths and
 * rejects a directory whose realpath differs from the path it was given.
 */
function canonicalTmpdir(): string {
  try {
    return fs.realpathSync.native(os.tmpdir());
  } catch {
    return os.tmpdir();
  }
}
