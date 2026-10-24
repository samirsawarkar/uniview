import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { execFile as defaultExecFile } from "node:child_process";
import { BridgeError } from "./bridge-proto.mjs";

const defaultFs = fs;
const defaultRandomBytes = crypto.randomBytes;

/**
 * Helper to run execFile supporting both callback and Promise-returning mocks.
 * @param {Function} execFileFn
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<{stdout: string, stderr: string} | string>}
 */
function runExecFile(execFileFn, file, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      const res = execFileFn(file, args, (err, stdout, stderr) => {
        if (settled) return;
        settled = true;
        if (err) {
          reject(err);
        } else {
          resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        }
      });
      if (res && typeof res.then === "function") {
        res.then(
          (val) => {
            if (settled) return;
            settled = true;
            resolve(val);
          },
          (err) => {
            if (settled) return;
            settled = true;
            reject(err);
          }
        );
      }
    } catch (err) {
      if (settled) return;
      settled = true;
      reject(err);
    }
  });
}

/**
 * Ensures the bridge directory exists with safe permissions.
 * On Unix, creates with 0700 and checks ownership and mode bits.
 * @param {string} userDataDir
 * @param {{ platform?: string, fs?: typeof import("node:fs/promises") }} [options]
 * @returns {Promise<string>} Path to the bridge directory
 */
export async function ensureBridgeDir(userDataDir, { platform = process.platform, fs = defaultFs } = {}) {
  const bridgeDir = path.join(userDataDir, "bridge");
  if (platform === "win32") {
    await fs.mkdir(bridgeDir, { recursive: true });
    return bridgeDir;
  }

  await fs.mkdir(bridgeDir, { recursive: true, mode: 0o700 });
  const st = await fs.stat(bridgeDir);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new BridgeError("bad_dir");
  }
  if ((st.mode & 0o077) !== 0) {
    throw new BridgeError("bad_dir");
  }
  return bridgeDir;
}

/**
 * Reads an existing 256-bit bridge key, validating file permissions.
 * Never creates the key.
 * @param {string} bridgeDir
 * @param {{ platform?: string, fs?: typeof import("node:fs/promises") }} [options]
 * @returns {Promise<Buffer>} 32-byte key buffer
 */
export async function readBridgeKey(bridgeDir, { platform = process.platform, fs = defaultFs } = {}) {
  const keyPath = path.join(bridgeDir, "key");
  let st;
  try {
    st = await fs.stat(keyPath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new BridgeError("no_key");
    }
    throw err;
  }

  if (platform !== "win32") {
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new BridgeError("bad_key_perms");
    }
    if ((st.mode & 0o077) !== 0) {
      throw new BridgeError("bad_key_perms");
    }
  }

  let buf;
  try {
    buf = await fs.readFile(keyPath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new BridgeError("no_key");
    }
    throw err;
  }

  if (buf.length !== 32) {
    throw new BridgeError("bad_key");
  }

  return buf;
}

/**
 * Ensures a 256-bit bridge key exists and has safe permissions.
 * If missing, creates atomically and configures ACLs/permissions.
 * @param {string} bridgeDir
 * @param {{
 *   platform?: string,
 *   fs?: typeof import("node:fs/promises"),
 *   execFile?: Function,
 *   randomBytes?: Function,
 *   username?: string
 * }} [options]
 * @returns {Promise<Buffer>} 32-byte key buffer
 */
export async function ensureBridgeKey(bridgeDir, {
  platform = process.platform,
  fs = defaultFs,
  execFile = defaultExecFile,
  randomBytes = defaultRandomBytes,
  username,
} = {}) {
  try {
    return await readBridgeKey(bridgeDir, { platform, fs });
  } catch (err) {
    if (!(err instanceof BridgeError && err.code === "no_key")) {
      throw err;
    }
  }

  const keyPath = path.join(bridgeDir, "key");
  const key = randomBytes(32);
  const tmpPath = path.join(
    bridgeDir,
    `key.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  );

  await fs.writeFile(tmpPath, key, { flag: "wx", mode: 0o600 });
  await fs.rename(tmpPath, keyPath);

  if (platform === "win32") {
    const user =
      username ||
      process.env.USERNAME ||
      (typeof os.userInfo === "function" ? os.userInfo().username : "") ||
      process.env.USER ||
      "USER";
    try {
      await runExecFile(execFile, "icacls", [
        keyPath,
        "/inheritance:r",
        "/grant:r",
        `${user}:F`,
      ]);
    } catch {
      await fs.unlink(keyPath).catch(() => {});
      throw new BridgeError("acl_failed");
    }
  } else {
    await fs.chmod(keyPath, 0o600).catch(() => {});
  }

  return key;
}

/**
 * Ensures a 16-byte random hex install id exists in <bridgeDir>/install-id.
 * @param {string} bridgeDir
 * @param {{ fs?: typeof import("node:fs/promises"), randomBytes?: Function }} [options]
 * @returns {Promise<string>} 32 hex character string
 */
export async function ensureInstallId(bridgeDir, {
  fs = defaultFs,
  randomBytes = defaultRandomBytes,
} = {}) {
  const idPath = path.join(bridgeDir, "install-id");
  try {
    const existing = (await fs.readFile(idPath, "utf8")).trim();
    if (existing.length === 32 && /^[0-9a-fA-F]+$/.test(existing)) {
      return existing;
    }
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      throw err;
    }
  }

  const id = randomBytes(16).toString("hex");
  const tmpPath = path.join(
    bridgeDir,
    `install-id.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  );
  await fs.writeFile(tmpPath, id, { flag: "wx", mode: 0o600 });
  await fs.rename(tmpPath, idPath);
  return id;
}

/**
 * Retrieves the Windows user SID via whoami /user /fo csv /nh.
 * @param {{ execFile?: Function }} [options]
 * @returns {Promise<string>} User SID string
 */
export async function windowsUserSid({ execFile = defaultExecFile } = {}) {
  let output;
  try {
    const res = await runExecFile(execFile, "whoami", ["/user", "/fo", "csv", "/nh"]);
    output = typeof res === "string" ? res : (res?.stdout || "");
  } catch {
    throw new BridgeError("bad_sid");
  }

  const lines = output.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const fields = [];
    const regex = /(?:^|,)(?:"([^"]*)"|([^,]*))/g;
    let match;
    while ((match = regex.exec(line)) !== null) {
      fields.push(match[1] !== undefined ? match[1] : match[2]);
      if (regex.lastIndex === line.length) break;
    }
    const candidate = fields[1]?.trim();
    if (candidate && /^S-1-[0-9-]+$/.test(candidate)) {
      return candidate;
    }
  }

  throw new BridgeError("bad_sid");
}

/**
 * Calculates the bridge rendezvous endpoint for the current platform.
 * @param {{ platform?: string, bridgeDir?: string, userSid?: string, installId?: string }} options
 * @returns {string} Windows named pipe path or Unix domain socket path
 */
export function bridgeEndpoint({
  platform = process.platform,
  bridgeDir,
  userSid,
  installId,
}) {
  if (platform === "win32") {
    if (!userSid || !installId) {
      throw new BridgeError("missing_endpoint_params");
    }
    const hash = crypto
      .createHash("sha256")
      .update(userSid + installId)
      .digest("hex")
      .slice(0, 16);
    return `\\\\.\\pipe\\uniview-bridge-${hash}`;
  }

  if (!bridgeDir) {
    throw new BridgeError("missing_endpoint_params");
  }

  // Unix socket paths always use "/" (path.join would use "\\" when run on a Windows host).
  const sockPath = path.posix.join(bridgeDir, "b.sock");
  if (Buffer.byteLength(sockPath) > 103) {
    throw new BridgeError("path_too_long");
  }
  return sockPath;
}
