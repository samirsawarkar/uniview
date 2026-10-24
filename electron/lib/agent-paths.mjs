// Agent path validation, drive classification, safe open policy, and scoped grant store.
// Pure Node ESM helpers without Electron imports for testability.

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

export const MAX_AGENT_PATH = 4096;
export const MAX_AGENT_FILE_BYTES = 4 * 1024 ** 3; // 4 GiB = 4,294,967,296 bytes
export const MAX_AGENT_HANDLES = 256;

export const NETWORK_FS_TYPES = new Set([
  "nfs",
  "nfs4",
  "cifs",
  "smb",
  "smb2",
  "smb3",
  "smbfs",
  "afpfs",
  "webdav",
  "davfs",
  "fuse.sshfs",
  "sshfs",
  "9p",
  "afs",
  "ceph",
  "glusterfs",
  "fuse.glusterfs",
  "lustre",
  "gpfs",
  "ncpfs",
]);

const WIN_DEVICE_REGEX =
  /^(?:CONIN\$|CONOUT\$|CON|PRN|AUX|NUL|COM[0-9\u00B9\u00B2\u00B3]|LPT[0-9\u00B9\u00B2\u00B3])(?:[\. ].*)?$/i;

/**
 * Check path string syntax and forbidden patterns without performing filesystem I/O.
 * Rules 1 and 2:
 * 1. String <= 4096 chars, no control characters (U+0000-U+001F, U+007F), absolute paths only.
 * 2. Reject before I/O: UNC paths, device prefixes (\\?\ and \\.\), Windows device names in any segment,
 *    alternate data streams (any ':' after drive letter), POSIX /dev, /proc, /sys leading segments,
 *    and any dot or dot-dot segments ('.' or '..') on both platforms.
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

  // Reject any '.' or '..' segment on both platforms (callers must pass normalized absolute paths)
  const segments = path.split(/[/\\]+/);
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      return { ok: false, code: "bad_path", reason: "Path contains dot or dot-dot segments ('.' or '..')" };
    }
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
      path.join(process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
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
 * Encode Linux major and minor device numbers into a dev_t BigInt matching glibc makedev.
 *
 * @param {number|string|bigint} major
 * @param {number|string|bigint} minor
 * @returns {bigint}
 */
export function linuxMakedev(major, minor) {
  const maj = typeof major === "bigint" ? Number(major) : parseInt(major, 10);
  const min = typeof minor === "bigint" ? Number(minor) : parseInt(minor, 10);
  return (
    BigInt(((maj & 0xfff) << 8) | (min & 0xff)) |
    (BigInt(min & ~0xff) << 12n) |
    (BigInt(maj & ~0xfff) << 32n)
  );
}

/**
 * Parse Linux /proc/self/mountinfo content into an array of { mountPoint, fsType, dev }.
 * Unescapes octal escapes such as \040 for spaces in the mount point.
 * Encodes major:minor directly into dev via linuxMakedev without stat.
 *
 * @param {string} content
 * @returns {Array<{ mountPoint: string, fsType: string, dev: bigint }>}
 */
export function parseLinuxMountinfo(content) {
  if (typeof content !== "string") return [];
  const lines = content.split("\n");
  const mounts = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sepIndex = trimmed.indexOf(" - ");
    if (sepIndex === -1) continue;
    const leftParts = trimmed.slice(0, sepIndex).trim().split(/\s+/);
    const rightParts = trimmed.slice(sepIndex + 3).trim().split(/\s+/);
    if (leftParts.length >= 5 && rightParts.length >= 1) {
      const majMin = leftParts[2].split(":");
      if (majMin.length === 2) {
        const major = parseInt(majMin[0], 10);
        const minor = parseInt(majMin[1], 10);
        if (!Number.isNaN(major) && !Number.isNaN(minor)) {
          const rawMountPoint = leftParts[4];
          const mountPoint = rawMountPoint.replace(/\\([0-7]{3})/g, (_, oct) =>
            String.fromCharCode(parseInt(oct, 8))
          );
          const fsType = rightParts[0];
          const dev = linuxMakedev(major, minor);
          mounts.push({ mountPoint, fsType, dev });
        }
      }
    }
  }
  return mounts;
}

/**
 * Parse Linux /proc/self/mounts content into an array of { mountPoint, fsType }.
 * Unescapes octal escapes such as \040 for spaces.
 *
 * @param {string} content
 * @returns {Array<{ mountPoint: string, fsType: string }>}
 */
export function parseLinuxMounts(content) {
  if (typeof content !== "string") return [];
  const lines = content.split("\n");
  const mounts = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 3) {
      const rawMountPoint = parts[1];
      const fsType = parts[2];
      const mountPoint = rawMountPoint.replace(/\\([0-7]{3})/g, (_, oct) =>
        String.fromCharCode(parseInt(oct, 8))
      );
      mounts.push({ mountPoint, fsType });
    }
  }
  return mounts;
}

/**
 * Parse macOS / other POSIX `mount` command output lines:
 * "... on <mountPoint> (<fsType>, ...)"
 *
 * @param {string} content
 * @returns {Array<{ mountPoint: string, fsType: string }>}
 */
export function parseMacMounts(content) {
  if (typeof content !== "string") return [];
  const lines = content.split("\n");
  const mounts = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^.+?\s+on\s+(.+?)\s+\(([^,\s)]+)/.exec(trimmed);
    if (match) {
      mounts.push({ mountPoint: match[1], fsType: match[2] });
    }
  }
  return mounts;
}

/**
 * Default reader for POSIX mounts.
 * On Linux, reads /proc/self/mountinfo and parses mount point, fsType, and dev directly.
 *
 * @param {string} [platform=process.platform]
 * @returns {Promise<Array<{ mountPoint: string, fsType: string, dev?: bigint }>>}
 */
export async function defaultReadMounts(platform = process.platform) {
  if (platform === "linux") {
    const data = await fsPromises.readFile("/proc/self/mountinfo", "utf8");
    return parseLinuxMountinfo(data);
  }
  return new Promise((resolve, reject) => {
    execFile("mount", [], { timeout: 3000 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(parseMacMounts(stdout));
    });
  });
}

/**
 * Default stat dev function returning bigint dev.
 *
 * @param {string} mountPoint
 * @returns {Promise<bigint>}
 */
export async function defaultStatDev(mountPoint) {
  const s = await fsPromises.stat(mountPoint, { bigint: true });
  return s.dev;
}

/**
 * Create a POSIX mount classifier caching network filesystem device IDs.
 * On Linux, devices are extracted directly from mountinfo without calling statDev.
 * On macOS / other POSIX, statDev is called; if statDev fails for ANY network mount,
 * the classifier fails closed and classifies every device as network until the next refresh.
 *
 * @param {object} [options]
 * @param {function} [options.readMounts=defaultReadMounts]
 * @param {function} [options.statDev=defaultStatDev]
 * @param {function} [options.now=Date.now]
 * @param {number} [options.ttlMs=60000]
 * @returns {function(bigint): Promise<boolean>}
 */
export function createMountClassifier({
  readMounts = defaultReadMounts,
  statDev = defaultStatDev,
  now = Date.now,
  ttlMs = 60_000,
} = {}) {
  let cachedResult = null;
  let expiresAt = 0;
  let inFlight = null;

  async function getNetworkDevs() {
    const currentTime = now();
    if (cachedResult && expiresAt > currentTime) {
      return cachedResult;
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      try {
        const mounts = await readMounts();
        const devs = new Set();
        let failAll = false;
        for (const m of mounts) {
          if (m && m.fsType && NETWORK_FS_TYPES.has(m.fsType.toLowerCase())) {
            if (typeof m.dev === "bigint") {
              devs.add(m.dev);
            } else if (m.mountPoint) {
              try {
                const res = await statDev(m.mountPoint);
                const dev = typeof res === "object" && res !== null && "dev" in res ? res.dev : res;
                if (typeof dev === "bigint") {
                  devs.add(dev);
                } else {
                  failAll = true;
                  break;
                }
              } catch {
                failAll = true;
                break;
              }
            }
          }
        }
        cachedResult = { devs, failAll };
        expiresAt = now() + ttlMs;
        return cachedResult;
      } catch {
        cachedResult = { devs: new Set(), failAll: true };
        expiresAt = now() + ttlMs;
        return cachedResult;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  async function isNetworkDev(dev) {
    try {
      const state = await getNetworkDevs();
      if (state.failAll) {
        return true;
      }
      return state.devs.has(dev);
    } catch {
      // Fail closed: if readMounts fails or times out, treat as network filesystem
      return true;
    }
  }

  isNetworkDev.isNetworkDev = isNetworkDev;
  return isNetworkDev;
}

const defaultMountClassifierInstance = createMountClassifier();

/**
 * Default drive lister for Windows logical disks via PowerShell.
 *
 * @returns {Promise<Array<{ letter: string, driveType: number }>>}
 */
export async function defaultListDrives() {
  const cmd = "Get-CimInstance Win32_LogicalDisk | ForEach-Object { $_.DeviceID + ',' + $_.DriveType }";
  return new Promise((resolve, reject) => {
    execFile(
      path.join(process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", cmd],
      { timeout: 3000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const lines = (stdout || "").split(/\r?\n/);
        const drives = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const commaIdx = trimmed.indexOf(",");
          if (commaIdx !== -1) {
            const devId = trimmed.slice(0, commaIdx).trim();
            const typeStr = trimmed.slice(commaIdx + 1).trim();
            const letter = devId.replace(/:$/, "").trim();
            const driveType = parseInt(typeStr, 10);
            if (letter && Number.isInteger(driveType)) {
              drives.push({ letter, driveType });
            }
          }
        }
        resolve(drives);
      }
    );
  });
}

/**
 * Create a Windows local volume classifier binding locality to opened handle device IDs.
 * Only DriveType 2 (removable) and 3 (fixed) are local.
 * Any failure of listDrives, timeout, or failed statDev for a type-2/3 drive fails closed
 * (isLocalDev returns false for everything until the next refresh).
 *
 * @param {object} [options]
 * @param {function} [options.listDrives=defaultListDrives]
 * @param {function} [options.statDev=defaultStatDev]
 * @param {function} [options.now=Date.now]
 * @param {number} [options.ttlMs=60000]
 * @param {number} [options.timeoutMs=3000]
 * @returns {function(bigint): Promise<boolean>}
 */
export function createLocalVolumeClassifier({
  listDrives = defaultListDrives,
  statDev = defaultStatDev,
  now = Date.now,
  ttlMs = 60_000,
  timeoutMs = 3000,
} = {}) {
  let cachedResult = null;
  let expiresAt = 0;
  let inFlight = null;

  async function refresh() {
    const currentTime = now();
    if (cachedResult && expiresAt > currentTime) {
      return cachedResult;
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      let timer;
      try {
        const timeoutPromise = new Promise((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        });

        const workPromise = (async () => {
          const rawDrives = await listDrives();
          const localDevs = new Set();
          if (!Array.isArray(rawDrives)) {
            return { ok: false, devs: new Set() };
          }
          for (const item of rawDrives) {
            let letter = "";
            let driveType = 0;
            if (typeof item === "string") {
              const commaIdx = item.indexOf(",");
              if (commaIdx !== -1) {
                letter = item.slice(0, commaIdx).trim().replace(/:$/, "");
                driveType = parseInt(item.slice(commaIdx + 1).trim(), 10);
              }
            } else if (item && typeof item === "object") {
              letter = String(item.letter || "").trim().replace(/:$/, "");
              driveType = Number(item.driveType);
            }
            if (driveType === 2 || driveType === 3) {
              if (!letter) {
                return { ok: false, devs: new Set() };
              }
              const res = await statDev(letter + ":\\");
              const dev = typeof res === "object" && res !== null && "dev" in res ? res.dev : res;
              if (typeof dev !== "bigint") {
                return { ok: false, devs: new Set() };
              }
              localDevs.add(dev);
            }
          }
          return { ok: true, devs: localDevs };
        })();

        const outcome = await Promise.race([workPromise, timeoutPromise]);
        clearTimeout(timer);
        if (outcome === "timeout") {
          cachedResult = { ok: false, devs: new Set() };
        } else {
          cachedResult = outcome;
        }
      } catch {
        cachedResult = { ok: false, devs: new Set() };
      } finally {
        clearTimeout(timer);
        expiresAt = now() + ttlMs;
        inFlight = null;
      }
      return cachedResult;
    })();

    return inFlight;
  }

  async function isLocalDev(dev) {
    if (typeof dev !== "bigint") return false;
    try {
      const res = await refresh();
      if (!res || !res.ok) {
        return false;
      }
      return res.devs.has(dev);
    } catch {
      return false;
    }
  }

  isLocalDev.isLocalDev = isLocalDev;
  return isLocalDev;
}

const defaultLocalVolumeClassifierInstance = createLocalVolumeClassifier();

let cachedForbiddenDevsPromise = null;

/**
 * Collect device IDs for /proc, /sys, /dev on POSIX, cached for the process.
 *
 * @param {object} [fs=fsPromises]
 * @returns {Promise<Set<bigint>>}
 */
export async function getForbiddenDevs(fs = fsPromises) {
  if (!cachedForbiddenDevsPromise) {
    cachedForbiddenDevsPromise = (async () => {
      const devs = new Set();
      for (const p of ["/proc", "/sys", "/dev"]) {
        try {
          const s = await fs.stat(p, { bigint: true });
          if (s && typeof s.dev === "bigint") {
            devs.add(s.dev);
          }
        } catch {
          // Optional: ignore ENOENT and access errors
        }
      }
      return devs;
    })();
  }
  return cachedForbiddenDevsPromise;
}

/**
 * Open an agent path safely following normative rules 1-4.
 *
 * @param {string} path - Path to open.
 * @param {object} [deps]
 * @param {string} [deps.platform=process.platform]
 * @param {object} [deps.fs=fsPromises]
 * @param {function} [deps.classifyDrive]
 * @param {function} [deps.isLocalDev]
 * @param {function} [deps.listDrives]
 * @param {function|Set<bigint>|Promise<Set<bigint>>} [deps.forbiddenDevs]
 * @param {function} [deps.isNetworkDev]
 * @param {function} [deps.readMounts]
 * @param {function} [deps.statDev]
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

  let timer;
  let timedOut = false;
  let handle = null;
  let handleClosed = false;

  // Fire-and-forget handle closing on every failure path; never awaited by the result path
  const closeHandleFireAndForget = (h) => {
    const target = h || handle;
    if (target && !handleClosed) {
      handleClosed = true;
      try {
        const p = target.close();
        if (p && typeof p.catch === "function") {
          p.catch(() => {});
        }
      } catch {}
    }
  };

  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      closeHandleFireAndForget(handle);
      resolve({ ok: false, code: "unreadable", reason: "Operation timed out" });
    }, timeoutMs);
  });

  const executionPromise = (async () => {
    try {
      // 2. Classify drive letter on win32 before touching filesystem
      let initialDrive = "";
      if (platform === "win32") {
        initialDrive = path[0].toUpperCase();
        const driveStatus = await classifyDrive(initialDrive);
        if (timedOut) return;
        if (driveStatus !== "allowed") {
          return { ok: false, code: "network_drive", reason: `Drive ${initialDrive}: is not an allowed local fixed/removable drive` };
        }
      }

      const openFlags =
        platform === "win32"
          ? "r"
          : ((fs.constants?.O_RDONLY ?? constants?.O_RDONLY ?? 0) |
             (fs.constants?.O_NONBLOCK ?? constants?.O_NONBLOCK ?? 0) |
             (fs.constants?.O_NOCTTY ?? constants?.O_NOCTTY ?? 0));

      const h = await fs.open(path, openFlags);
      if (timedOut) {
        closeHandleFireAndForget(h);
        return;
      }
      handle = h;

      const realpathFn = typeof fs.realpath?.native === "function"
        ? fs.realpath.native.bind(fs.realpath)
        : typeof fs.realpath === "function"
          ? fs.realpath.bind(fs)
          : null;

      if (!realpathFn) {
        closeHandleFireAndForget();
        return { ok: false, code: "unreadable", reason: "realpath function not available" };
      }

      let canonical = await realpathFn(path);
      if (timedOut) {
        closeHandleFireAndForget();
        return;
      }

      // Windows: strip extended-length prefix \\?\ from drive paths returned by realpath.native
      if (platform === "win32" && typeof canonical === "string") {
        if (canonical.startsWith("\\\\?\\") && /^[a-zA-Z]:[/\\]/.test(canonical.slice(4))) {
          canonical = canonical.slice(4);
        }
      }

      // Re-apply rule 2 to the canonical path
      const checkCanonical = checkPathString(canonical, platform);
      if (!checkCanonical.ok) {
        closeHandleFireAndForget();
        return { ok: false, code: "bad_path", reason: checkCanonical.reason };
      }

      // On win32, classify canonical drive if different
      if (platform === "win32") {
        const canonicalDrive = canonical[0].toUpperCase();
        if (canonicalDrive !== initialDrive) {
          const canonicalClass = await classifyDrive(canonicalDrive);
          if (timedOut) return;
          if (canonicalClass !== "allowed") {
            closeHandleFireAndForget();
            return { ok: false, code: "network_drive", reason: `Canonical drive ${canonicalDrive}: is not an allowed local fixed/removable drive` };
          }
        }
      }

      // Inspect handle directly: decide on the handle, not on path names
      const handleStat = await handle.stat({ bigint: true });
      if (timedOut) {
        closeHandleFireAndForget();
        return;
      }

      // Windows: bind locality to the opened handle's device ID
      if (platform === "win32") {
        const isLocalDev = deps.isLocalDev ?? (
          (deps.listDrives || deps.statDev)
            ? createLocalVolumeClassifier({ listDrives: deps.listDrives, statDev: deps.statDev })
            : defaultLocalVolumeClassifierInstance
        );
        let local = false;
        try {
          local = await isLocalDev(handleStat.dev);
        } catch {
          local = false;
        }
        if (timedOut) return;
        if (!local) {
          closeHandleFireAndForget();
          return { ok: false, code: "network_drive", reason: "Handle device is not an allowed local volume" };
        }
      }

      // Check forbidden POSIX filesystems (/proc, /sys, /dev) by device ID
      if (platform !== "win32" || deps.forbiddenDevs !== undefined) {
        let forbiddenDevs;
        if (deps.forbiddenDevs !== undefined) {
          const raw = typeof deps.forbiddenDevs === "function" ? await deps.forbiddenDevs() : await deps.forbiddenDevs;
          forbiddenDevs = raw instanceof Set ? raw : new Set(raw);
        } else {
          forbiddenDevs = await getForbiddenDevs(fs);
        }
        if (timedOut) return;
        if (forbiddenDevs && forbiddenDevs.has(handleStat.dev)) {
          closeHandleFireAndForget();
          return { ok: false, code: "bad_path", reason: "Handle device is a forbidden filesystem (/proc, /sys, /dev)" };
        }
      }

      // Check network filesystems by device ID
      if (platform !== "win32" || deps.isNetworkDev !== undefined || deps.readMounts !== undefined) {
        const isNetDev = deps.isNetworkDev ?? (
          (deps.readMounts || deps.statDev)
            ? createMountClassifier({ readMounts: deps.readMounts, statDev: deps.statDev })
            : defaultMountClassifierInstance
        );
        let isNet = false;
        try {
          isNet = await isNetDev(handleStat.dev);
        } catch {
          isNet = true; // fail closed
        }
        if (timedOut) return;
        if (isNet) {
          closeHandleFireAndForget();
          return { ok: false, code: "network_drive", reason: "Path is on a network drive" };
        }
      }

      // Rule 4: regular file and size <= 4 GiB
      if (!handleStat.isFile()) {
        closeHandleFireAndForget();
        return { ok: false, code: "not_a_file", reason: "Opened path is not a regular file" };
      }

      if (handleStat.size > BigInt(MAX_AGENT_FILE_BYTES)) {
        closeHandleFireAndForget();
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
    } catch (err) {
      closeHandleFireAndForget();
      if (err?.code === "ENOENT") {
        return { ok: false, code: "not_found", reason: err.message };
      }
      if (err?.code === "EISDIR") {
        return { ok: false, code: "not_a_file", reason: err.message };
      }
      return { ok: false, code: "unreadable", reason: err?.message || String(err) };
    }
  })();

  try {
    const result = await Promise.race([executionPromise, timeoutPromise]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scoped store for agent file grants.
 * Enforces an aggregate limit of 256 agent file handles across all scopes.
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
   * Throws an error with code: "busy" when 256 handles are already held across all scopes.
   *
   * @param {string} scopeId - Scope id returned by openScope.
   * @param {{ handle: any, canonical: string, size: number }} opened - Opened handle record.
   * @returns {string} 16-byte random hex grant token.
   */
  grant(scopeId, opened) {
    const scope = this.#scopes.get(scopeId);
    if (!scope || scope.closed) {
      throw new Error(`Scope '${scopeId}' is invalid or closed`);
    }

    if (this.#byToken.size >= MAX_AGENT_HANDLES) {
      const err = new Error(`Aggregate agent handle limit (${MAX_AGENT_HANDLES}) reached`);
      err.code = "busy";
      throw err;
    }

    const token = randomBytes(16).toString("hex");
    const entry = {
      handle: opened?.handle,
      canonical: opened?.canonical,
      size: opened?.size,
      scopeId,
    };
    this.#byToken.set(token, entry);
    scope.tokens.add(token);
    if (opened?.handle) {
      scope.handles.add(opened.handle);
    }
    return token;
  }

  /**
   * Retrieve a grant record by token. Requires scopeId and returns undefined
   * unless the token belongs to that specific scope.
   *
   * @param {string} token
   * @param {string} scopeId
   * @returns {{ handle: any, canonical: string, size: number, scopeId: string } | undefined}
   */
  get(token, scopeId) {
    if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) {
      return undefined;
    }
    if (typeof scopeId !== "string" || !scopeId) {
      return undefined;
    }
    const entry = this.#byToken.get(token);
    if (!entry || entry.scopeId !== scopeId) {
      return undefined;
    }
    return entry;
  }

  /**
   * Check whether a token belongs to a specific scope.
   *
   * @param {string} token
   * @param {string} scopeId
   * @returns {boolean}
   */
  inScope(token, scopeId) {
    const entry = this.get(token, scopeId);
    return Boolean(entry);
  }

  /**
   * Close every handle belonging to a scope, remove its tokens, and mark it closed. Idempotent.
   *
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
   *
   * @returns {Promise<void>}
   */
  async closeAll() {
    const scopeIds = Array.from(this.#scopes.keys());
    await Promise.all(scopeIds.map((id) => this.closeScope(id)));
  }
}
