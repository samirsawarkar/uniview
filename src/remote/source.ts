// A FileSource backed by a paired computer, so every viewer works on remote files unchanged.
import type { FileSource } from "../core/types";
import type { RemoteHost, RemoteEntry } from "../../shared/remote-client.mjs";
import { nextId } from "../shells/sources";
import { streamUrl } from "./stream";

const CHUNK = 1024 * 1024;
const CACHE_BYTES = 128 * 1024 * 1024;
const PARALLEL = 4;

/** Decrypted chunks shared by all remote files: LRU by insertion order, bounded by bytes. */
const cache = new Map<string, Uint8Array>();
let cachedBytes = 0;

function cacheGet(key: string): Uint8Array | undefined {
  const v = cache.get(key);
  if (v) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

function cachePut(key: string, v: Uint8Array): void {
  if (cache.has(key)) return;
  cache.set(key, v);
  cachedBytes += v.length;
  for (const [k, old] of cache) {
    if (cachedBytes <= CACHE_BYTES) break;
    cache.delete(k);
    cachedBytes -= old.length;
  }
}

export function clearRemoteCache(): void {
  cache.clear();
  cachedBytes = 0;
}

export interface RemoteFileRef {
  host: RemoteHost;
  hostName: string;
  root: string;
  path: string; // relative, "/"-separated
  entry: RemoteEntry;
}

export function remoteSource(ref: RemoteFileRef): FileSource {
  const { host, root, path, entry } = ref;
  const keyBase = `${host.record.hostId}|${root}|${path}|${entry.mtime}|`;
  const inflight = new Map<number, Promise<Uint8Array>>();
  let url: string | undefined;
  let release: (() => void) | undefined;

  const chunk = (i: number): Promise<Uint8Array> => {
    const key = keyBase + i;
    const hit = cacheGet(key);
    if (hit) return Promise.resolve(hit);
    let p = inflight.get(i);
    if (!p) {
      p = host.read(root, path, i * CHUNK, Math.min(entry.size, (i + 1) * CHUNK)).then((bytes) => {
        cachePut(key, bytes);
        return bytes;
      });
      inflight.set(i, p);
      p.finally(() => inflight.delete(i)).catch(() => {});
    }
    return p;
  };

  const readRange = async (start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer> => {
    end = Math.min(end, entry.size);
    if (end <= start) return new ArrayBuffer(0);
    const first = Math.floor(start / CHUNK);
    const last = Math.floor((end - 1) / CHUNK);
    const out = new Uint8Array(end - start);
    // Fetch chunks a few at a time, in order, so large files arrive steadily without flooding the host.
    for (let i = first; i <= last; i += PARALLEL) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const ids: number[] = [];
      for (let j = i; j <= Math.min(last, i + PARALLEL - 1); j++) ids.push(j);
      const parts = await Promise.all(ids.map(chunk));
      parts.forEach((bytes, k) => {
        const idx = ids[k]!;
        const chunkStart = idx * CHUNK;
        const from = Math.max(start, chunkStart) - chunkStart;
        const to = Math.min(end, chunkStart + bytes.length) - chunkStart;
        if (to > from) out.set(bytes.subarray(from, to), chunkStart + from - start);
      });
    }
    return out.buffer;
  };

  return {
    id: nextId(),
    name: entry.name,
    size: entry.size,
    path: `${ref.hostName}: ${path}`,
    readAll: (signal) => readRange(0, entry.size, signal),
    readRange,
    async url() {
      if (url) return url;
      const s = await streamUrl(entry.name, entry.size, readRange);
      url = s.url;
      release = s.release;
      return url;
    },
    release() {
      release?.();
      release = undefined;
      url = undefined;
    },
  };
}
