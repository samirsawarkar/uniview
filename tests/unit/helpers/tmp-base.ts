import fs from "node:fs";
import os from "node:os";

/**
 * Base directory for test scratch files.
 *
 * The developer machine keeps scratch data on the shared I: drive (`I:\AES\tmp`). CI runners and
 * other machines have no such drive, so they fall back to the OS temp directory. The drive is
 * only used when its parent folder (`I:\AES`) really exists, and the `tmp` folder is created on
 * demand so callers can rely on the returned directory existing.
 */
const AES_ROOT = "I:\AES";
const AES_TMP = "I:\AES\tmp";

export function tmpBase(): string {
  if (process.platform === "win32" && fs.existsSync(AES_ROOT)) {
    try {
      fs.mkdirSync(AES_TMP, { recursive: true });
      return AES_TMP;
    } catch {
      // read-only or otherwise unusable: fall through to the OS temp directory
    }
  }
  return os.tmpdir();
}

/** Scratch root for tests that previously used `I:\AES` itself rather than its `tmp` child. */
export function aesRoot(): string {
  if (process.platform === "win32" && fs.existsSync(AES_ROOT)) return AES_ROOT;
  return os.tmpdir();
}
