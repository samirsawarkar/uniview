// Agent path validation, drive classification, safe open policy, and scoped grant store.
// Pure Node ESM helpers without Electron imports for testability.

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fsPromises from "node:fs/promises";

export const MAX_AGENT_PATH = 4096;
export const MAX_AGENT_FILE_BYTES = 4 * 1024 ** 3; // 4 GiB = 4,294,967,296 bytes

const WIN_DEVICE_REGEX =
  /^(?:CONIN\$|CONOUT\$|CON|PRN|AUX|NUL|COM[0-9\u00B9\u00B2\u00B3]|LPT[0-9\u00B9\u00B2\u00B3])(?:[\. ].*)?$/i;

/**
 * Check path string syntax and forbidden patterns without performing filesystem I/O.
 * Rules 1 and 2:
 * 1. String <= 4096 chars, no control characters (U+0000-U+001F, U+007F), absolute paths only.
 * 2. Reject before I/O: UNC paths, device prefixes (\\?\ and \\.\), Windows device names in any segment,
 *    alternate data streams (any ':' after drive letter), and POSIX /dev, /proc, /sys leading segments.
 *
 * @param {string} path - Path to validate.
 * @param {string} [platform=process.platform] - Target platform ("win32" or posix).
 * @returns {{ ok: true } | { ok: false, code: "bad_path", reason: string }}
 */
export function checkPathString(path, platform = process.platform) {
  if (typeof path !== "string") {
    return { ok: false, code: "bad_path", reason: "Path must be a string" };
  }
  if (path.length === 0) {
    return { ok: false, code: "bad_path", reason: "Path cannot be empty" };
  }
  if (path.length > MAX_AGENT_PATH) {
    return { ok: false, code: "bad_path", reason: `Path exceeds maximum length of ${MAX_AGENT_PATH} characters` };
  }
  if (/[\u0000-\u001F\u007F]/.test(path)) {
    return { ok: false, code: "bad_path", reason: "Path contains control characters" };
  }

  // Reject UNC paths and device prefixes on all platforms
  if (path.startsWith("\\\\") || path.startsWith("//") || path.startsWith("\\/") || path.startsWith("/\\")) {
    return { ok: false, code: "bad_path", reason: "UNC paths and device prefixes are not allowed" };
  }

  if (platform === "win32") {
    // Windows paths must be absolute drive paths (e.g. C:\... or C:/...)
    if (!/^[a-zA-Z]:[/\\]/.test(path)) {
      return { ok: false, code: "bad_path", reason: "Windows paths must be absolute drive paths starting with a drive letter" };
    }

    // Alternate Data Streams: any ':' after the drive letter (index >= 2)
    if (path.indexOf(":", 2) !== -1) {
      return { ok: false, code: "bad_path", reason: "Alternate data streams are not allowed" };
    }

    // Windows device names in any path segment (case-insensitive, with extension or trailing dots/spaces)
    const segments = path.split(/[/\\]+/);
    for (const seg of segments) {
      if (WIN_DEVICE_REGEX.test(seg)) {
        return { ok: false, code: "bad_path", reason: `Windows device name '${seg}' is not allowed` };
      }
    }
  } else {
    // POSIX paths must be absolute starting with '/'
    if (!path.startsWith("/")) {
      return { ok: false, code: "bad_path", reason: "POSIX paths must be absolute starting with /" };
    }

    // POSIX virtual and device filesystems as whole leading segments: /dev, /proc, /sys
    if (/^\/(?:dev|proc|sys)(?:\/|$)/.test(path)) {
      return { ok: false, code: "bad_path", reason: "Paths under /dev, /proc, or /sys are not allowed" };
    }
  }

  return { ok: true };
}

/**
 * Default drive lookup for Windows using powershell.exe and Get-CimInstance.
 * Validates the letter as a single character first.
 *
 * @param {string} letter - Single drive letter (e.g. "C").
 * @returns {Promise<number | null>} Numeric DriveType (e.g. 2, 3, 4) or null.
 */
export async function defaultDriveLookup(letter) {
  if (typeof letter !== "string" || !/^[A-Za-z]$/.test(letter)) {
    return null;
  }
  const upper = letter.toUpperCase();
  const cmd = `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${upper}:'").DriveType`;
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", cmd],
      { timeout: 3000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const val = parseInt(stdout?.trim(), 10);
        resolve(Number.isInteger(val) ? val : null);
      }
    );
  });
}

/**
 * Create a drive classifier function with caching and timeout support.
 * Only DriveType 2 (removable) and 3 (fixed) are allowed; all others fail closed to "rejected".
 *
 * @param {object} [options]
 * @param {function} [options.lookup=defaultDriveLookup] - Lookup function resolving numeric DriveType or null.
 * @param {function} [options.now=Date.now] - Clock function.
 * @param {number} [options.ttlMs=60000] - Cache TTL in milliseconds.
 * @param {number} [options.timeoutMs=3000] - Lookup timeout in milliseconds.
 * @returns {function(string): Promise<"allowed" | "rejected">}
 */
export function createDriveClassifier({
  lookup = defaultDriveLookup,
  now = Date.now,
  ttlMs = 60_000,
  timeoutMs = 3000,
} = {}) {
  /** @type {Map<string, { outcome: "allowed" | "rejected", expiresAt: number }>} */
  const cache = new Map();

  return async function classify(letter) {
    let key = "";
    if (typeof letter === "string") {
      const m = /^[A-Za-z]/.exec(letter);
      if (m) key = m[0].toUpperCase();
    }
    if (!key) {
      return "rejected";
    }

    const currentTime = now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > currentTime) {
      return cached.outcome;
    }

    let outcome = "rejected";
    let timer;
    try {
      const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const lookupPromise = Promise.resolve().then(() => lookup(key));
      const res = await Promise.race([lookupPromise, timeoutPromise]);
      if (res !== "timeout") {
        clearTimeout(timer);
        if (res === 2 || res === 3) {
          outcome = "allowed";
        }
      }
    } catch {
      outcome = "rejected";
    } finally {
      clearTimeout(timer);
    }

    cache.set(key, { outcome, expiresAt: now() + ttlMs });
    return outcome;
  };
}

const defaultDriveClassifierInstance = createDriveClassifier();

/**
 * Open an agent path safely following normative rules 1-4.
 *
 * @param {string} path - Path to open.
 * @param {object} [deps]
 * @param {string} [deps.platform=process.platform]
 * @param {object} [deps.fs=fsPromises]
 * @param {function} [deps.classifyDrive]
 * @param {number} [deps.timeoutMs=5000]
 * @returns {Promise<{ ok: true, handle: any, canonical: string, size: number, dev: bigint, ino: bigint } | { ok: false, code: string, reason: string }>}
 */
export async function openAgentPath(path, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const fs = deps.fs ?? fsPromises;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const classifyDrive = deps.classifyDrive ?? defaultDriveClassifierInstance;

  // 1. Validate path string rules 1 and 2
  const checkInitial = checkPathString(path, platform);
  if (!checkInitial.ok) {
    return checkInitial;
  }

  // 2. Classify drive letter on win32 before touching filesystem
  let initialDrive = "";
  if (platform === "win32") {
    initialDrive = path[0].toUpperCase();
    const driveStatus = await classifyDrive(initialDrive);
    if (driveStatus !== "allowed") {
      return { ok: false, code: "network_drive", reason: `Drive ${initialDrive}: is not an allowed local fixed/removable drive` };
    }
  }

  // 3. Open first, then validate what was opened
  let timer;
  let timedOut = false;
  let handle = null;
  let handleClosed = false;

  const closeHandle = async (h) => {
    const target = h || handle;
    if (target && !handleClosed) {
      handleClosed = true;
      try {
        await target.close();
      } catch {}
    }
  };

  try {
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const err = new Error("Operation timed out");
        err.code = "ETIMEDOUT";
        reject(err);
      }, timeoutMs);
    });

    const executionPromise = (async () => {
      const openFlags =
        platform === "win32"
          ? "r"
          : ((fs.constants?.O_RDONLY ?? constants?.O_RDONLY ?? 0) |
             (fs.constants?.O_NONBLOCK ?? constants?.O_NONBLOCK ?? 0) |
             (fs.constants?.O_NOCTTY ?? constants?.O_NOCTTY ?? 0));

      const h = await fs.open(path, openFlags);
      if (timedOut) {
        await closeHandle(h);
        return null;
      }
      handle = h;

      const realpathFn = typeof fs.realpath?.native === "function"
        ? fs.realpath.native.bind(fs.realpath)
        : typeof fs.realpath === "function"
          ? fs.realpath.bind(fs)
          : null;

      if (!realpathFn) {
        await closeHandle();
        return { ok: false, code: "unreadable", reason: "realpath function not available" };
      }

      const canonical = await realpathFn(path);
      if (timedOut) {
        await closeHandle();
        return null;
      }

      // Re-apply rule 2 to the canonical path
      const checkCanonical = checkPathString(canonical, platform);
      if (!checkCanonical.ok) {
        await closeHandle();
        return { ok: false, code: "bad_path", reason: checkCanonical.reason };
      }

      // On win32, classify canonical drive if different
      if (platform === "win32") {
        const canonicalDrive = canonical[0].toUpperCase();
        if (canonicalDrive !== initialDrive) {
          const canonicalClass = await classifyDrive(canonicalDrive);
          if (canonicalClass !== "allowed") {
            await closeHandle();
            return { ok: false, code: "network_drive", reason: `Canonical drive ${canonicalDrive}: is not an allowed local fixed/removable drive` };
          }
        }
      }

      // Verify dev and ino agreement (bigint)
      const [canonicalStat, handleStat] = await Promise.all([
        fs.stat(canonical, { bigint: true }),
        handle.stat({ bigint: true }),
      ]);

      if (timedOut) {
        await closeHandle();
        return null;
      }

      if (canonicalStat.dev !== handleStat.dev || canonicalStat.ino !== handleStat.ino) {
        await closeHandle();
        return { ok: false, code: "changed", reason: "Device or inode mismatch between canonical path and opened handle" };
      }

      // Rule 4: regular file and size <= 4 GiB
      if (!handleStat.isFile()) {
        await closeHandle();
        return { ok: false, code: "not_a_file", reason: "Opened path is not a regular file" };
      }

      if (handleStat.size > BigInt(MAX_AGENT_FILE_BYTES)) {
        await closeHandle();
        return { ok: false, code: "too_large", reason: `File size exceeds maximum allowed of ${MAX_AGENT_FILE_BYTES} bytes` };
      }

      return {
        ok: true,
        handle,
        canonical,
        size: Number(handleStat.size),
        dev: handleStat.dev,
        ino: handleStat.ino,
      };
    })();

    executionPromise.catch(() => {});

    const result = await Promise.race([executionPromise, timeoutPromise]);
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    await closeHandle();

    if (err?.code === "ENOENT") {
      return { ok: false, code: "not_found", reason: err.message };
    }
    if (err?.code === "EISDIR") {
      return { ok: false, code: "not_a_file", reason: err.message };
    }
    if (err?.code === "EPERM") {
      try {
        const s = await fs.stat(path);
        if (s.isDirectory()) {
          return { ok: false, code: "not_a_file", reason: "Path is a directory" };
        }
      } catch {}
    }
    return { ok: false, code: "unreadable", reason: err?.message || String(err) };
  }
}

/**
 * Scoped store for agent file grants.
 */
export class AgentGrantStore {
  /** @type {Map<string, { closed: boolean, tokens: Set<string>, handles: Set<any> }>} */
  #scopes = new Map();

  /** @type {Map<string, { handle: any, canonical: string, size: number, scopeId: string }>} */
  #byToken = new Map();

  /**
   * Open a new view scope.
   * @returns {string} 16-byte random hex scope id.
   */
  openScope() {
    const scopeId = randomBytes(16).toString("hex");
    this.#scopes.set(scopeId, {
      closed: false,
      tokens: new Set(),
      handles: new Set(),
    });
    return scopeId;
  }

  /**
   * Grant access to an opened file handle within a scope.
   * @param {string} scopeId - Scope id returned by openScope.
   * @param {{ handle: any, canonical: string, size: number }} opened - Opened handle record.
   * @returns {string} 16-byte random hex grant token.
   */
  grant(scopeId, opened) {
    const scope = this.#scopes.get(scopeId);
    if (!scope || scope.closed) {
      throw new Error(`Scope '${scopeId}' is invalid or closed`);
    }
    const token = randomBytes(16).toString("hex");
    const entry = {
      handle: opened.handle,
      canonical: opened.canonical,
      size: opened.size,
      scopeId,
    };
    this.#byToken.set(token, entry);
    scope.tokens.add(token);
    if (opened.handle) {
      scope.handles.add(opened.handle);
    }
    return token;
  }

  /**
   * Retrieve a grant record by token. Rejects malformed tokens.
   * @param {string} token
   * @returns {{ handle: any, canonical: string, size: number, scopeId: string } | undefined}
   */
  get(token) {
    if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) {
      return undefined;
    }
    return this.#byToken.get(token);
  }

  /**
   * Check whether a token belongs to a specific scope.
   * @param {string} token
   * @param {string} scopeId
   * @returns {boolean}
   */
  inScope(token, scopeId) {
    const entry = this.get(token);
    return Boolean(entry && entry.scopeId === scopeId);
  }

  /**
   * Close every handle belonging to a scope, remove its tokens, and mark it closed. Idempotent.
   * @param {string} scopeId
   * @returns {Promise<void>}
   */
  async closeScope(scopeId) {
    const scope = this.#scopes.get(scopeId);
    if (!scope || scope.closed) {
      return;
    }
    scope.closed = true;

    for (const token of scope.tokens) {
      this.#byToken.delete(token);
    }
    scope.tokens.clear();

    const handlesToClose = Array.from(scope.handles);
    scope.handles.clear();

    const closePromises = handlesToClose.map(async (h) => {
      if (typeof h?.close === "function") {
        try {
          await h.close();
        } catch {}
      }
    });
    await Promise.all(closePromises);
  }

  /**
   * Close all active scopes and their open handles.
   * @returns {Promise<void>}
   */
  async closeAll() {
    const scopeIds = Array.from(this.#scopes.keys());
    await Promise.all(scopeIds.map((id) => this.closeScope(id)));
  }
}
