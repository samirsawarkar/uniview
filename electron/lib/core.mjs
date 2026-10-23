// Pure helpers for the Electron main process. No electron imports, so they are unit-testable.
import { randomBytes } from "node:crypto";
import { isAbsolute, normalize, resolve, sep, extname } from "node:path";

/**
 * Parse an HTTP Range header against a file size.
 * Returns { start, end } (inclusive end), null for no/ignorable range, or "unsatisfiable".
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === "" && m[2] === "")) return null; // multi-range or malformed: serve the whole file
  let start;
  let end;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return "unsatisfiable";
  return { start, end };
}

/** Files the user granted (picker, drop, argv, recents). Tokens are unguessable and per-session. */
export class GrantStore {
  #byToken = new Map();
  #byPath = new Map();

  grant(path, size) {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    const existing = this.#byPath.get(key);
    if (existing) {
      existing.size = size;
      return existing.token;
    }
    const token = randomBytes(16).toString("hex");
    const entry = { token, path, size };
    this.#byToken.set(token, entry);
    this.#byPath.set(key, entry);
    return token;
  }

  get(token) {
    return typeof token === "string" && /^[0-9a-f]{32}$/.test(token) ? this.#byToken.get(token) : undefined;
  }
}

/** Resolve a URL path inside root, refusing anything that escapes it. */
export function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const rel = normalize(decoded.replace(/^[/\\]+/, ""));
  if (isAbsolute(rel)) return null;
  const full = resolve(root, rel);
  const base = resolve(root);
  return full === base || full.startsWith(base + sep) ? full : null;
}

/** File paths passed on the command line (file associations, "Open with"). */
export function filesFromArgv(argv, isPackaged) {
  const args = argv.slice(isPackaged ? 1 : 2);
  return args.filter((a) => a && !a.startsWith("-") && a !== "." && isAbsolute(a));
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".bmp": "image/bmp",
  ".wasm": "application/wasm", ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream", ".ttf": "font/ttf",
  ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".icc": "application/vnd.iccprofile",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".ogv": "video/ogg", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav",
  ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".pdf": "application/pdf",
};

export function contentType(path) {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Only these schemes may load in the app; everything else (http, https, ws, ftp, file) is cancelled. */
export function isAllowedUrl(url) {
  return /^(uniview|uniview-file|blob|data|devtools|chrome-extension):/i.test(url);
}

/** Validate a read request from the renderer. */
export function checkReadArgs(start, end, size, max) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return "invalid range";
  if (end - start > max) return `a single read is limited to ${max} bytes`;
  if (start > size) return "range starts past the end of the file";
  return null;
}

/** True only for the app's own top-level page; subframes, other origins and missing frames are refused. */
export function isAppFrame(frame) {
  return !!frame && frame === frame.top && typeof frame.url === "string" && frame.url.startsWith("uniview://app/");
}
