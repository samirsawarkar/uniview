import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { execFile as nodeExecFile } from "node:child_process";
import { BridgeError } from "./bridge-proto.mjs";

const defaultFs = fs;

/** Absolute System32 path for the Windows tools we run, so a PATH entry can never substitute them. */
export function systemToolPath(name, env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return path.join(root, "System32", name + ".exe");
}

/** A DOMAIN\\user name, or undefined: a bare short name never identifies an account. */
function fullAccountName(name) {
  return typeof name === "string" && name.includes("\\") ? name : undefined;
}

/** The program actually run for `file`: icacls and whoami come from System32 on Windows, never from PATH. */
export function resolveTool(file, platform = process.platform, env = process.env) {
  return platform === "win32" && (file === "icacls" || file === "whoami") ? systemToolPath(file, env) : file;
}

/** Default executor; tests inject their own executor. */
function defaultExecFile(file, args, cb) {
  const resolved = resolveTool(file);
  return nodeExecFile(resolved, args, { windowsHide: true, timeout: 10_000 }, cb);
}
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
 * Parses icacls output into structured entries.
 * @param {string} output
 * @param {string} [filePath]
 * @returns {Array<{ principal: string, rights: string, inherited: boolean }>}
 */
export function parseIcaclsEntries(output, filePath) {
  if (!output || typeof output !== "string") return [];

  const lines = output.split(/\r?\n/);
  const entries = [];

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    if (
      line.startsWith("Successfully processed") ||
      line.startsWith("Failed processing") ||
      line.startsWith("No files found")
    ) {
      continue;
    }

    if (filePath) {
      const candidates = [
        filePath,
        filePath.replace(/\//g, "\\"),
        filePath.replace(/\\/g, "/"),
      ];
      for (const c of candidates) {
        if (line.toLowerCase().startsWith(c.toLowerCase())) {
          line = line.slice(c.length).trim();
          break;
        }
        const quoted = `"${c}"`;
        if (line.toLowerCase().startsWith(quoted.toLowerCase())) {
          line = line.slice(quoted.length).trim();
          break;
        }
      }
    }

    const pathMatch = line.match(/^(?:[a-zA-Z]:\\[^:]*?|"[^"]+?")\s+/);
    if (pathMatch) {
      line = line.slice(pathMatch[0].length).trim();
    }

    if (!line) continue;

    const parenIdx = line.indexOf("(");
    if (parenIdx === -1) continue;
    const colonIdx = line.lastIndexOf(":", parenIdx);
    if (colonIdx === -1) continue;

    const principal = line.slice(0, colonIdx).trim();
    const rawRights = line.slice(colonIdx + 1).trim();

    if (!principal || !rawRights) continue;

    const inherited = /\(I\)/i.test(rawRights);
    const rights = rawRights.replace(/\(I\)/gi, "").trim();

    entries.push({ principal, rights, inherited });
  }

  return entries;
}

/**
 * Retrieves the current Windows account name and SID via whoami /user /fo csv /nh.
 * @param {{ execFile?: Function }} [options]
 * @returns {Promise<{ name: string, sid: string }>}
 */
export async function currentWindowsAccount({ execFile = defaultExecFile } = {}) {
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
    const name = fields[0]?.trim();
    const sid = fields[1]?.trim();
    if (name && sid && /^S-1-[0-9-]+$/i.test(sid)) {
      return { name, sid };
    }
  }

  throw new BridgeError("bad_sid");
}

/**
 * Verifies that a Windows file or directory has strictly owner-only ACL permissions.
 * @param {string} targetPath
 * @param {{ isDirectory?: boolean, execFile?: Function, username?: string, accountName?: string, userSid?: string }} options
 */
async function verifyWindowsAcl(targetPath, {
  isDirectory = false,
  execFile = defaultExecFile,
  username,
  accountName,
  userSid,
} = {}) {
  let stdout;
  try {
    const res = await runExecFile(execFile, "icacls", [targetPath]);
    stdout = typeof res === "string" ? res : (res?.stdout || "");
  } catch {
    throw new BridgeError(isDirectory ? "bad_dir" : "bad_key_perms");
  }

  const entries = parseIcaclsEntries(stdout, targetPath);
  if (entries.length !== 1) {
    throw new BridgeError(isDirectory ? "bad_dir" : "bad_key_perms");
  }

  const [entry] = entries;

  if (entry.inherited) {
    throw new BridgeError(isDirectory ? "bad_dir" : "bad_key_perms");
  }

  if (isDirectory) {
    const validDirRights =
      entry.rights === "(OI)(CI)(F)" ||
      entry.rights === "(CI)(OI)(F)" ||
      entry.rights === "(OI)(CI)F" ||
      entry.rights === "(F)";
    if (!validDirRights) {
      throw new BridgeError("bad_dir");
    }
  } else {
    if (entry.rights !== "(F)") {
      throw new BridgeError("bad_key_perms");
    }
  }

  // Only the full DOMAIN\user name or the SID identify the account; a bare short name never does.
  let expectedName = fullAccountName(accountName);
  let expectedSid = userSid;

  if (!expectedSid) {
    try {
      const acct = await currentWindowsAccount({ execFile });
      expectedName = expectedName || acct.name;
      expectedSid = acct.sid;
    } catch {
      throw new BridgeError(isDirectory ? "bad_dir" : "bad_key_perms");
    }
  }

  let matches = false;
  const principal = entry.principal.trim();

  if (expectedName && principal.toLowerCase() === expectedName.toLowerCase()) {
    matches = true;
  }

  if (!matches && expectedSid) {
    const cleanSid = expectedSid.startsWith("*")
      ? expectedSid.slice(1).toLowerCase()
      : expectedSid.toLowerCase();
    const cleanPrincipal = principal.startsWith("*")
      ? principal.slice(1).toLowerCase()
      : principal.toLowerCase();
    if (cleanPrincipal === cleanSid) {
      matches = true;
    }
  }

  if (!matches) {
    throw new BridgeError(isDirectory ? "bad_dir" : "bad_key_perms");
  }
}

/**
 * Ensures the bridge directory exists with safe permissions.
 * On Unix, creates with 0700 and checks ownership and mode bits.
 * On Windows, configures owner-only ACL *<SID>:(OI)(CI)F and verifies on start.
 * @param {string} userDataDir
 * @param {{ platform?: string, fs?: typeof import("node:fs/promises"), execFile?: Function, username?: string, accountName?: string, userSid?: string }} [options]
 * @returns {Promise<string>} Path to the bridge directory
 */
export async function ensureBridgeDir(userDataDir, {
  platform = process.platform,
  fs = defaultFs,
  execFile = defaultExecFile,
  username,
  accountName,
  userSid,
} = {}) {
  const bridgeDir = path.join(userDataDir, "bridge");
  if (platform === "win32") {
    let existed = false;
    try {
      const st = await fs.stat(bridgeDir);
      if (!st.isDirectory()) {
        throw new BridgeError("bad_dir");
      }
      existed = true;
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      if (err && err.code !== "ENOENT") throw err;
    }

    let sid = userSid;
    let name = fullAccountName(accountName);
    if (!sid) {
      try {
        const acct = await currentWindowsAccount({ execFile });
        sid = acct.sid;
        if (!name) name = acct.name;
      } catch {
        throw new BridgeError("bad_dir");
      }
    }

    if (!existed) {
      await fs.mkdir(bridgeDir, { recursive: true });
      const grantSid = sid.startsWith("*") ? sid : `*${sid}`;
      try {
        await runExecFile(execFile, "icacls", [
          bridgeDir,
          "/inheritance:r",
          "/grant:r",
          `${grantSid}:(OI)(CI)F`,
        ]);
      } catch {
        throw new BridgeError("bad_dir");
      }
    }

    await verifyWindowsAcl(bridgeDir, {
      isDirectory: true,
      execFile,
      username: name,
      accountName: name,
      userSid: sid,
    });

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
 * @param {{ platform?: string, fs?: typeof import("node:fs/promises"), execFile?: Function, username?: string, accountName?: string, userSid?: string }} [options]
 * @returns {Promise<Buffer>} 32-byte key buffer
 */
export async function readBridgeKey(bridgeDir, {
  platform = process.platform,
  fs = defaultFs,
  execFile = defaultExecFile,
  username,
  accountName,
  userSid,
} = {}) {
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

  if (platform === "win32") {
    await verifyWindowsAcl(keyPath, {
      isDirectory: false,
      execFile,
      username,
      accountName,
      userSid,
    });
  } else {
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
 * If missing, creates atomically and configures ACLs/permissions safely.
 * @param {string} bridgeDir
 * @param {{
 *   platform?: string,
 *   fs?: typeof import("node:fs/promises"),
 *   execFile?: Function,
 *   randomBytes?: Function,
 *   username?: string,
 *   accountName?: string,
 *   userSid?: string
 * }} [options]
 * @returns {Promise<Buffer>} 32-byte key buffer
 */
export async function ensureBridgeKey(bridgeDir, {
  platform = process.platform,
  fs = defaultFs,
  execFile = defaultExecFile,
  randomBytes = defaultRandomBytes,
  username,
  accountName,
  userSid,
} = {}) {
  try {
    return await readBridgeKey(bridgeDir, {
      platform,
      fs,
      execFile,
      username,
      accountName,
      userSid,
    });
  } catch (err) {
    if (!(err instanceof BridgeError && err.code === "no_key")) {
      throw err;
    }
  }

  const keyPath = path.join(bridgeDir, "key");
  const tmpPath = path.join(
    bridgeDir,
    `key.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  );

  // Step 1: create an empty temp file with flag wx
  await fs.writeFile(tmpPath, Buffer.alloc(0), { flag: "wx", mode: 0o600 });

  try {
    if (platform === "win32") {
      let sid = userSid;
      let name = fullAccountName(accountName);
      if (!sid) {
        try {
          const acct = await currentWindowsAccount({ execFile });
          sid = acct.sid;
          if (!name) name = acct.name;
        } catch {
          throw new BridgeError("acl_failed");
        }
      }

      const grantSid = sid.startsWith("*") ? sid : `*${sid}`;
      // Step 2: apply ACL to temp file
      try {
        await runExecFile(execFile, "icacls", [
          tmpPath,
          "/inheritance:r",
          "/grant:r",
          `${grantSid}:F`,
        ]);
      } catch {
        throw new BridgeError("acl_failed");
      }

      // Step 3: verify with the same check
      await verifyWindowsAcl(tmpPath, {
        isDirectory: false,
        execFile,
        username: name,
        accountName: name,
        userSid: sid,
      });
    } else {
      await fs.chmod(tmpPath, 0o600).catch(() => {});
      const st = await fs.stat(tmpPath);
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
        throw new BridgeError("bad_key_perms");
      }
      if ((st.mode & 0o077) !== 0) {
        throw new BridgeError("bad_key_perms");
      }
    }

    // Step 4: write the 32 secret bytes only after ACL verification
    const key = randomBytes(32);
    await fs.writeFile(tmpPath, key);

    // Step 5: rename to final destination
    await fs.rename(tmpPath, keyPath);

    return key;
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
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
  const account = await currentWindowsAccount({ execFile });
  return account.sid;
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
