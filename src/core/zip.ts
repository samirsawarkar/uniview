import { Inflate } from "fflate";
import { CorruptFileError } from "./errors";

export interface ZipEntry {
  name: string;
  /** Uncompressed size declared in the central directory (may lie; never trusted for allocation). */
  size: number;
  compressedSize: number;
  isDirectory: boolean;
}

interface CdEntry extends ZipEntry {
  method: number;
  localOffset: number;
}

/** Most bytes UniView inflates from one archive entry. */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
/** Most bytes one package may inflate in total, however many parts it has (bounds zip-bomb memory). */
export const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;

function asBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

const utf8 = new TextDecoder("utf-8");
const cp437 = new TextDecoder("latin1");

/**
 * Read the central directory. Each name appears once (the first entry wins), so duplicate
 * entries cannot be used to inflate the same budget twice.
 */
function centralDirectory(b: Uint8Array): CdEntry[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new CorruptFileError("This archive could not be read: no end-of-central-directory record.");
  let count = v.getUint16(eocd + 10, true);
  let cdSize = v.getUint32(eocd + 12, true);
  let cdOffset = v.getUint32(eocd + 16, true);
  // ZIP64: the locator sits just before the classic record.
  if ((count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) && eocd >= 20 && v.getUint32(eocd - 20, true) === 0x07064b50) {
    const rec = Number(v.getBigUint64(eocd - 12, true));
    if (rec + 56 > b.length || v.getUint32(rec, true) !== 0x06064b50) throw new CorruptFileError("This archive's ZIP64 record is damaged.");
    count = Number(v.getBigUint64(rec + 32, true));
    cdSize = Number(v.getBigUint64(rec + 40, true));
    cdOffset = Number(v.getBigUint64(rec + 48, true));
  }
  if (cdOffset + cdSize > b.length) throw new CorruptFileError("This archive is truncated: its file list lies past the end of the file.");
  const out: CdEntry[] = [];
  const seen = new Set<string>();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || v.getUint32(p, true) !== 0x02014b50) throw new CorruptFileError("This archive's file list is damaged.");
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    let compressedSize = v.getUint32(p + 20, true);
    let size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    let localOffset = v.getUint32(p + 42, true);
    if (p + 46 + nameLen + extraLen > b.length) throw new CorruptFileError("This archive's file list is damaged.");
    const rawName = b.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800 ? utf8 : cp437).decode(rawName);
    // ZIP64 extended information extra field.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = v.getUint16(e, true);
      const len = v.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff && q + 8 <= e + 4 + len) { size = Number(v.getBigUint64(q, true)); q += 8; }
        if (compressedSize === 0xffffffff && q + 8 <= e + 4 + len) { compressedSize = Number(v.getBigUint64(q, true)); q += 8; }
        if (localOffset === 0xffffffff && q + 8 <= e + 4 + len) { localOffset = Number(v.getBigUint64(q, true)); }
      }
      e += 4 + len;
    }
    if (!seen.has(name)) {
      seen.add(name);
      out.push({ name, size, compressedSize, isDirectory: name.endsWith("/"), method, localOffset });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** List entries from the central directory without inflating anything. */
export function listZip(data: ArrayBuffer | Uint8Array): ZipEntry[] {
  return centralDirectory(asBytes(data)).map(({ name, size, compressedSize, isDirectory }) => ({ name, size, compressedSize, isDirectory }));
}

/** The compressed bytes of an entry, located through its local header. */
function compressedData(b: Uint8Array, e: CdEntry): Uint8Array {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const p = e.localOffset;
  if (p + 30 > b.length || v.getUint32(p, true) !== 0x04034b50) throw new CorruptFileError(`"${e.name}" is damaged in this archive.`);
  const start = p + 30 + v.getUint16(p + 26, true) + v.getUint16(p + 28, true);
  const end = start + e.compressedSize;
  if (end > b.length) throw new CorruptFileError(`"${e.name}" is truncated in this archive.`);
  return b.subarray(start, end);
}

/**
 * Inflate one entry, counting real output bytes as they are produced and stopping at `limit`.
 * Declared sizes are never trusted: a stored or deflated entry that produces more than it declares is refused.
 */
function inflateEntry(b: Uint8Array, e: CdEntry, limit: number, keep: boolean): { bytes?: Uint8Array; length: number } {
  if (e.isDirectory) return { bytes: keep ? new Uint8Array(0) : undefined, length: 0 };
  const data = compressedData(b, e);
  const tooBig = () => new CorruptFileError(`"${e.name}" expands to more than ${Math.round(limit / 1048576)} MB, so UniView stopped reading it.`);
  const mismatch = () => new CorruptFileError(`"${e.name}" is larger than this archive says it is, so UniView will not trust it.`);
  if (e.method === 0) {
    if (data.length > limit) throw tooBig();
    if (data.length !== e.size) throw mismatch();
    return { bytes: keep ? data.slice() : undefined, length: data.length };
  }
  if (e.method !== 8) throw new CorruptFileError(`"${e.name}" uses a compression method UniView does not support (${e.method}).`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflater = new Inflate((chunk) => {
    total += chunk.length;
    if (total > limit) throw tooBig();
    if (total > e.size) throw mismatch();
    if (keep) chunks.push(chunk);
  });
  const STEP = 64 * 1024;
  try {
    for (let off = 0; off < data.length; off += STEP) inflater.push(data.subarray(off, off + STEP), off + STEP >= data.length);
    if (data.length === 0) inflater.push(new Uint8Array(0), true);
  } catch (err) {
    if (err instanceof CorruptFileError) throw err;
    throw new CorruptFileError(`"${e.name}" could not be decompressed: ${(err as Error).message}`);
  }
  if (!keep) return { length: total };
  if (chunks.length === 1) return { bytes: chunks[0]!, length: total };
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return { bytes: out, length: total };
}

/** Read selected entries, with the per-entry limit and a shared total budget. */
export function readZipEntries(
  data: ArrayBuffer | Uint8Array,
  want: (name: string) => boolean,
  budget = MAX_PACKAGE_BYTES,
): Map<string, Uint8Array> {
  const b = asBytes(data);
  const out = new Map<string, Uint8Array>();
  let used = 0;
  for (const e of centralDirectory(b)) {
    if (!want(e.name)) continue;
    const r = inflateEntry(b, e, Math.min(MAX_ENTRY_BYTES, budget - used), true);
    used += r.length;
    out.set(e.name, r.bytes!);
  }
  return out;
}

/**
 * Inflate every entry without keeping the output, to prove an archive stays within `budget`
 * before handing it to a library (docx-preview, SheetJS) that would inflate it unchecked.
 */
export function assertZipWithinBudget(data: ArrayBuffer | Uint8Array, budget = MAX_PACKAGE_BYTES): number {
  const b = asBytes(data);
  let used = 0;
  for (const e of centralDirectory(b)) used += inflateEntry(b, e, Math.min(MAX_ENTRY_BYTES, budget - used), false).length;
  return used;
}

/** An in-memory view over a ZIP package, with lazy, cached part reads under a total budget. */
export class ZipPackage {
  private readonly bytes: Uint8Array;
  private readonly byName = new Map<string, CdEntry>();
  private readonly cache = new Map<string, Uint8Array>();
  private inflated = 0;
  readonly entries: ZipEntry[];

  constructor(data: ArrayBuffer | Uint8Array, private readonly budget = MAX_PACKAGE_BYTES) {
    this.bytes = asBytes(data);
    const cd = centralDirectory(this.bytes);
    for (const e of cd) this.byName.set(e.name, e);
    this.entries = cd.map(({ name, size, compressedSize, isDirectory }) => ({ name, size, compressedSize, isDirectory }));
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Case-insensitive lookup; OOXML part names are case-insensitive by spec. */
  resolve(name: string): string | undefined {
    if (this.byName.has(name)) return name;
    const lower = name.toLowerCase();
    for (const n of this.byName.keys()) if (n.toLowerCase() === lower) return n;
    return undefined;
  }

  bytesOf(name: string): Uint8Array | undefined {
    const real = this.resolve(name);
    if (!real) return undefined;
    const hit = this.cache.get(real);
    if (hit) return hit;
    const remaining = this.budget - this.inflated;
    if (remaining <= 0) throw new CorruptFileError(`This file expands to more than ${Math.round(this.budget / 1048576)} MB of content, so UniView stopped reading it.`);
    const r = inflateEntry(this.bytes, this.byName.get(real)!, Math.min(MAX_ENTRY_BYTES, remaining), true);
    this.inflated += r.length;
    this.cache.set(real, r.bytes!);
    return r.bytes;
  }

  text(name: string): string | undefined {
    const b = this.bytesOf(name);
    return b ? decodeText(b) : undefined;
  }
}

/** Decode bytes to text, honouring a UTF-8/UTF-16 byte order mark and falling back to Windows-1252. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Resolve a relative OPC/EPUB target against the directory of a source part. */
export function resolvePath(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const base = fromPart.includes("/") ? fromPart.slice(0, fromPart.lastIndexOf("/") + 1) : "";
  const parts = (base + target).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  let joined = out.join("/");
  const hash = joined.indexOf("#");
  if (hash >= 0) joined = joined.slice(0, hash);
  try {
    return decodeURIComponent(joined);
  } catch {
    return joined;
  }
}
