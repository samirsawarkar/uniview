import { unzipSync, type UnzipFileInfo } from "fflate";
import { CorruptFileError } from "./errors";

export interface ZipEntry {
  name: string;
  /** Uncompressed size in bytes. */
  size: number;
  compressedSize: number;
  isDirectory: boolean;
}

/** Most bytes UniView inflates from one archive entry (guards against zip bombs). */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

function asBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** List entries from the central directory without inflating anything. */
export function listZip(data: ArrayBuffer | Uint8Array): ZipEntry[] {
  const entries: ZipEntry[] = [];
  try {
    unzipSync(asBytes(data), {
      filter(info: UnzipFileInfo) {
        entries.push({
          name: info.name,
          size: info.originalSize,
          compressedSize: info.size,
          isDirectory: info.name.endsWith("/"),
        });
        return false;
      },
    });
  } catch (err) {
    throw new CorruptFileError(`This archive could not be read: ${(err as Error).message}`);
  }
  return entries;
}

/** Read selected entries. `want` receives each entry name; return true to extract it. */
export function readZipEntries(
  data: ArrayBuffer | Uint8Array,
  want: (name: string) => boolean,
): Map<string, Uint8Array> {
  let out: Record<string, Uint8Array>;
  try {
    out = unzipSync(asBytes(data), {
      filter(info) {
        if (!want(info.name)) return false;
        if (info.originalSize > MAX_ENTRY_BYTES) {
          throw new CorruptFileError(`"${info.name}" expands to more than 512 MB, so UniView will not open it.`);
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof CorruptFileError) throw err;
    throw new CorruptFileError(`This archive could not be read: ${(err as Error).message}`);
  }
  return new Map(Object.entries(out));
}

/** Most bytes one package may inflate in total, however many parts it has (bounds zip-bomb memory). */
export const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;

/** An in-memory view over a ZIP package, with lazy, cached part reads under a total budget. */
export class ZipPackage {
  private readonly bytes: Uint8Array;
  private readonly names: Set<string>;
  private readonly sizes = new Map<string, number>();
  private readonly cache = new Map<string, Uint8Array>();
  private inflated = 0;
  readonly entries: ZipEntry[];

  constructor(data: ArrayBuffer | Uint8Array, private readonly budget = MAX_PACKAGE_BYTES) {
    this.bytes = asBytes(data);
    this.entries = listZip(this.bytes);
    this.names = new Set(this.entries.map((e) => e.name));
    for (const e of this.entries) this.sizes.set(e.name, e.size);
  }

  has(name: string): boolean {
    return this.names.has(name);
  }

  /** Case-insensitive lookup; OOXML part names are case-insensitive by spec. */
  resolve(name: string): string | undefined {
    if (this.names.has(name)) return name;
    const lower = name.toLowerCase();
    for (const n of this.names) if (n.toLowerCase() === lower) return n;
    return undefined;
  }

  bytesOf(name: string): Uint8Array | undefined {
    const real = this.resolve(name);
    if (!real) return undefined;
    const hit = this.cache.get(real);
    if (hit) return hit;
    // Check the declared size before inflating so a bomb never allocates.
    const declared = this.sizes.get(real) ?? 0;
    if (this.inflated + declared > this.budget) {
      throw new CorruptFileError(`This file expands to more than ${Math.round(this.budget / 1048576)} MB of content, so UniView stopped reading it.`);
    }
    const part = readZipEntries(this.bytes, (n) => n === real).get(real);
    if (part) {
      this.inflated += Math.max(declared, part.length);
      this.cache.set(real, part);
    }
    return part;
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
