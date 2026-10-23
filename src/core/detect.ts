import type { Detection, FormatKind } from "./types";

/** How many leading bytes detection wants. Shells read this much before choosing a viewer. */
export const DETECT_HEAD_BYTES = 64 * 1024;

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    // Dotfiles such as ".gitignore" use the whole name as their type.
    return dot === 0 ? base.slice(1).toLowerCase() : "";
  }
  return base.slice(dot + 1).toLowerCase();
}

const CODE_LANGUAGES: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  py: "python", pyw: "python", rb: "ruby", php: "php", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", go: "go", rs: "rust", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp",
  hh: "cpp", cs: "csharp", m: "objectivec", mm: "objectivec", scala: "scala", dart: "dart", lua: "lua",
  pl: "perl", pm: "perl", r: "r", sql: "sql", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
  psm1: "powershell", bat: "dos", cmd: "dos", html: "xml", htm: "xml", xhtml: "xml", xml: "xml",
  svg: "xml", xsl: "xml", xsd: "xml", plist: "xml", css: "css", scss: "scss", less: "less",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", properties: "properties",
  gradle: "gradle", groovy: "groovy", dockerfile: "dockerfile", makefile: "makefile", mk: "makefile",
  cmake: "cmake", diff: "diff", patch: "diff", vue: "xml", graphql: "graphql", gql: "graphql",
  proto: "protobuf", tex: "latex", latex: "latex", hs: "haskell", ex: "elixir", exs: "elixir",
  erl: "erlang", clj: "clojure", fs: "fsharp", vb: "vbnet", asm: "x86asm", s: "x86asm", json: "json",
  gitignore: "bash", env: "bash", nginx: "nginx", vim: "vim", zig: "zig", nim: "nim",
};

const TEXT_EXTS = new Set([
  "txt", "text", "log", "out", "srt", "vtt", "sub", "nfo", "readme", "license", "lst", "tsv",
  ...Object.keys(CODE_LANGUAGES),
]);
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "mdx"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "jfif", "pjpeg", "gif", "webp", "bmp", "ico", "avif", "svg", "apng"]);
const VIDEO_EXTS = new Set(["mp4", "m4v", "mov", "webm", "mkv", "ogv", "3gp", "3g2", "avi", "wmv", "flv", "mpeg", "mpg", "m2ts", "mts"]);
const AUDIO_EXTS = new Set(["mp3", "m4a", "aac", "wav", "wave", "ogg", "oga", "opus", "flac", "weba", "wma", "aiff", "aif", "mid", "midi", "amr"]);
const SHEET_EXTS = new Set(["xlsx", "xlsm", "xlsb", "xls", "xltx", "xltm", "ods", "fods", "csv", "tsv", "numbers"]);
const FONT_EXTS = new Set(["ttf", "otf", "woff", "woff2"]);
const ZIP_EXTS = new Set(["zip", "jar", "apk", "aar", "whl", "nupkg", "vsix", "xpi", "cbz"]);

const LABELS: Record<FormatKind, string> = {
  pdf: "PDF document", image: "Image", tiff: "TIFF image", video: "Video", audio: "Audio",
  docx: "Word document", sheet: "Spreadsheet", pptx: "PowerPoint presentation", epub: "EPUB book",
  zip: "ZIP archive", markdown: "Markdown", json: "JSON", text: "Text", font: "Font",
  "legacy-office": "Legacy Office document", binary: "Binary file",
};

function startsWith(b: Uint8Array, sig: number[], offset = 0): boolean {
  if (b.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[offset + i] !== sig[i]) return false;
  return true;
}

function ascii(b: Uint8Array, start: number, len: number): string {
  let s = "";
  for (let i = start; i < Math.min(b.length, start + len); i++) s += String.fromCharCode(b[i]!);
  return s;
}

function make(kind: FormatKind, ext: string, by: Detection["by"], label?: string, language?: string): Detection {
  return { kind, ext, by, label: label ?? LABELS[kind], ...(language ? { language } : {}) };
}

/** Names of entries whose local headers appear in the leading bytes of a ZIP. */
export function zipLocalNames(head: Uint8Array): string[] {
  const names: string[] = [];
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let p = 0;
  while (p + 30 <= head.length && names.length < 64) {
    if (view.getUint32(p, true) !== 0x04034b50) break;
    const flags = view.getUint16(p + 6, true);
    const compSize = view.getUint32(p + 18, true);
    const nameLen = view.getUint16(p + 26, true);
    const extraLen = view.getUint16(p + 28, true);
    if (p + 30 + nameLen > head.length) break;
    names.push(new TextDecoder().decode(head.subarray(p + 30, p + 30 + nameLen)));
    // With a data descriptor (bit 3) the size is unknown here; stop and rely on what we have.
    if (flags & 0x08) break;
    p += 30 + nameLen + extraLen + compSize;
  }
  return names;
}

/** Classify a ZIP-based container from entry names (from local headers or the central directory). */
export function classifyZipEntries(names: string[], head?: Uint8Array): FormatKind | null {
  const set = new Set(names);
  if (head && names[0] === "mimetype" && ascii(head, 38, 20) === "application/epub+zip") return "epub";
  if (set.has("META-INF/container.xml") && names.some((n) => n.endsWith(".opf"))) return "epub";
  if (set.has("word/document.xml")) return "docx";
  if (set.has("xl/workbook.xml") || set.has("xl/workbook.bin")) return "sheet";
  if (set.has("ppt/presentation.xml")) return "pptx";
  if (set.has("content.xml") && head) {
    const mt = ascii(head, 38, 60);
    if (mt.includes("opendocument.spreadsheet")) return "sheet";
  }
  return null;
}

function containsUtf16(head: Uint8Array, word: string): boolean {
  const needle: number[] = [];
  for (const ch of word) needle.push(ch.charCodeAt(0), 0);
  outer: for (let i = 0; i + needle.length <= head.length; i++) {
    for (let j = 0; j < needle.length; j++) if (head[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * True when bytes are valid UTF-8. When `complete` is false the bytes are a prefix of a longer file,
 * so only a multi-byte sequence cut off at the very end is forgiven.
 */
export function isUtf8(bytes: Uint8Array, complete: boolean): boolean {
  let end = bytes.length;
  if (!complete) {
    // Walk back over up to 3 continuation bytes to the start of the last sequence.
    let i = end - 1;
    let cont = 0;
    while (i >= 0 && cont < 3 && (bytes[i]! & 0xc0) === 0x80) {
      i--;
      cont++;
    }
    if (i >= 0) {
      const lead = bytes[i]!;
      const need = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : 0;
      if (need > cont) end = i; // incomplete final sequence: validate everything before it
    }
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    return true;
  } catch {
    return false;
  }
}

/** True when the bytes look like human-readable text. */
export function looksLikeText(head: Uint8Array): boolean {
  if (head.length === 0) return true;
  if (startsWith(head, [0xef, 0xbb, 0xbf]) || startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) return true;
  const sample = head.subarray(0, Math.min(head.length, 8192));
  let control = 0;
  for (const c of sample) {
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32 && c !== 27)) control++;
  }
  if (control / sample.length > 0.02) return false;
  // The sample may cut a multi-byte character in half; isUtf8 forgives only that.
  if (isUtf8(sample, false)) return true;
  // Not UTF-8. Treat mostly-printable single-byte text (Latin-1, Windows-1252) as text too.
  let printable = 0;
  for (const c of sample) if (c >= 32 || c === 9 || c === 10 || c === 13) printable++;
  return printable / sample.length > 0.95;
}

function byExtension(ext: string): Detection | null {
  if (ext === "pdf") return make("pdf", ext, "extension");
  if (ext === "tif" || ext === "tiff") return make("tiff", ext, "extension");
  if (IMAGE_EXTS.has(ext)) return make("image", ext, "extension", `${ext.toUpperCase()} image`);
  if (VIDEO_EXTS.has(ext)) return make("video", ext, "extension");
  if (AUDIO_EXTS.has(ext)) return make("audio", ext, "extension");
  if (ext === "docx" || ext === "docm" || ext === "dotx" || ext === "dotm") return make("docx", ext, "extension");
  if (ext === "pptx" || ext === "pptm" || ext === "ppsx" || ext === "potx" || ext === "ppsm") return make("pptx", ext, "extension");
  if (SHEET_EXTS.has(ext)) return make("sheet", ext, "extension", ext === "csv" || ext === "tsv" ? "CSV table" : undefined);
  if (ext === "epub") return make("epub", ext, "extension");
  if (ZIP_EXTS.has(ext)) return make("zip", ext, "extension");
  if (MARKDOWN_EXTS.has(ext)) return make("markdown", ext, "extension");
  if (ext === "json" || ext === "jsonc" || ext === "geojson" || ext === "webmanifest" || ext === "ipynb") return make("json", ext, "extension");
  if (FONT_EXTS.has(ext)) return make("font", ext, "extension");
  if (ext === "doc" || ext === "ppt" || ext === "pps" || ext === "msg") return make("legacy-office", ext, "extension");
  if (TEXT_EXTS.has(ext)) return make("text", ext, "extension", undefined, CODE_LANGUAGES[ext]);
  return null;
}

/**
 * Decide which viewer opens a file. Signatures beat container contents, which beat the
 * extension, which beats a content guess. `head` is the first DETECT_HEAD_BYTES (or fewer).
 */
export function detect(name: string, head: Uint8Array, mimeHint?: string): Detection {
  const ext = extOf(name);
  const b = head;

  if (ascii(b, 0, 1024).includes("%PDF-")) return make("pdf", ext, "signature");
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return make("image", ext, "signature", "PNG image");
  if (startsWith(b, [0xff, 0xd8, 0xff])) return make("image", ext, "signature", "JPEG image");
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return make("image", ext, "signature", "GIF image");
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return make("image", ext, "signature", "WebP image");
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") return make("audio", ext, "signature", "WAV audio");
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "AVI ") return make("video", ext, "signature", "AVI video");
  if (ascii(b, 0, 2) === "BM" && b.length > 14 && (b[14] === 12 || b[14] === 40 || b[14] === 108 || b[14] === 124)) return make("image", ext, "signature", "BMP image");
  if (startsWith(b, [0x00, 0x00, 0x01, 0x00]) && (ext === "ico" || ext === "")) return make("image", ext, "signature", "Icon");
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) return make("tiff", ext, "signature");
  if (ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    if (brand === "avif" || brand === "avis") return make("image", ext, "signature", "AVIF image");
    if (brand.startsWith("heic") || brand === "heix" || brand === "mif1" || brand === "msf1") {
      return make("binary", ext, "signature", "HEIC image (not supported yet)");
    }
    if (brand.startsWith("M4A") || brand === "M4B " || brand === "M4P " || AUDIO_EXTS.has(ext)) return make("audio", ext, "signature", "MPEG-4 audio");
    return make("video", ext, "signature", brand.startsWith("qt") ? "QuickTime video" : "MPEG-4 video");
  }
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) {
    return AUDIO_EXTS.has(ext) ? make("audio", ext, "signature", "WebM audio") : make("video", ext, "signature", "Matroska/WebM video");
  }
  if (ascii(b, 0, 4) === "OggS") {
    return VIDEO_EXTS.has(ext) ? make("video", ext, "signature", "Ogg video") : make("audio", ext, "signature", "Ogg audio");
  }
  if (b.length > 376 && b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47) return make("video", ext, "signature", "MPEG transport stream");
  if (ascii(b, 0, 4) === "fLaC") return make("audio", ext, "signature", "FLAC audio");
  if (ascii(b, 0, 3) === "ID3" || (b.length > 1 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (ext === "mp3" || ext === "aac" || ext === ""))) {
    return make("audio", ext, "signature", ascii(b, 0, 3) === "ID3" || ext === "mp3" ? "MP3 audio" : "Audio");
  }
  if (ascii(b, 0, 4) === "wOFF") return make("font", ext, "signature", "WOFF font");
  if (ascii(b, 0, 4) === "wOF2") return make("font", ext, "signature", "WOFF2 font");
  if (ascii(b, 0, 4) === "OTTO" || (startsWith(b, [0x00, 0x01, 0x00, 0x00]) && FONT_EXTS.has(ext)) || ascii(b, 0, 4) === "true") {
    return make("font", ext, "signature", "OpenType font");
  }

  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) {
    const kind = classifyZipEntries(zipLocalNames(b), b);
    if (kind) return make(kind, ext, "container");
    // Office files written with data descriptors hide later entries; trust an Office extension.
    const byExt = byExtension(ext);
    if (byExt && ["docx", "pptx", "sheet", "epub", "zip"].includes(byExt.kind)) return { ...byExt, by: "container" };
    return make("zip", ext, "container");
  }

  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    if (ext === "xls" || ext === "xlt" || containsUtf16(b, "Workbook") || containsUtf16(b, "Book")) {
      return make("sheet", ext, "container", "Excel 97-2003 workbook");
    }
    if (ext === "doc" || containsUtf16(b, "WordDocument")) return make("legacy-office", ext, "container", "Word 97-2003 document");
    if (ext === "ppt" || containsUtf16(b, "PowerPoint Document")) return make("legacy-office", ext, "container", "PowerPoint 97-2003 presentation");
    return make("legacy-office", ext, "container");
  }

  const byExt = byExtension(ext);
  if (byExt) {
    // An extension that promises binary media but holds text is more useful shown as text.
    if ((byExt.kind === "image" && ext !== "svg") || byExt.kind === "video" || byExt.kind === "audio" || byExt.kind === "font") {
      if (b.length > 0 && looksLikeText(b) && !(byExt.kind === "audio" || byExt.kind === "video")) {
        return make("text", ext, "content");
      }
    }
    return byExt;
  }

  if (mimeHint) {
    const mt = mimeHint.toLowerCase();
    if (mt === "application/pdf") return make("pdf", ext, "extension");
    if (mt.startsWith("image/svg")) return make("image", ext, "extension", "SVG image");
    if (mt.startsWith("video/")) return make("video", ext, "extension");
    if (mt.startsWith("audio/")) return make("audio", ext, "extension");
    if (mt === "application/json") return make("json", ext, "extension");
    if (mt === "text/markdown") return make("markdown", ext, "extension");
  }

  if (looksLikeText(b)) {
    const start = new TextDecoder().decode(b.subarray(0, 512)).trimStart();
    if (start.startsWith("<svg") || (start.startsWith("<?xml") && start.includes("<svg"))) return make("image", ext, "content", "SVG image");
    if ((start.startsWith("{") || start.startsWith("[")) && b.length < 64 * 1024) {
      try {
        JSON.parse(new TextDecoder().decode(b));
        return make("json", ext, "content");
      } catch {
        /* not JSON, fall through to plain text */
      }
    }
    return make("text", ext, "content");
  }
  return make("binary", ext, "content");
}

export function languageFor(ext: string): string | undefined {
  return CODE_LANGUAGES[ext];
}
