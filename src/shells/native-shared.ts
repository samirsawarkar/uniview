import type { FileSource } from "../core/types";
import { nextId } from "./sources";
import { streamUrl } from "../remote/stream";

export const SHARED_SPAN = 8 * 1024 * 1024;

export function sharedSource(
  token: string,
  name: string,
  size: number,
  mime: string,
  base = "",
): FileSource {
  let streamPromise: Promise<{ url: string; release: () => void }> | undefined;
  let streamRelease: (() => void) | undefined;
  let closed = false;

  const readRange = async (
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> => {
    const clampedEnd = Math.min(end, size);
    if (clampedEnd <= start) {
      return new ArrayBuffer(0);
    }

    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    for (let s = start; s < clampedEnd; s += SHARED_SPAN) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const e = Math.min(s + SHARED_SPAN, clampedEnd);
      const url = `${base}/_uniview_shared/${token}?start=${s}&end=${e}`;
      const res = await (signal ? fetch(url, { signal }) : fetch(url));
      if (res.status !== 200) {
        throw new Error(`Could not read "${name}" (HTTP ${res.status})`);
      }
      const buf = await res.arrayBuffer();
      const u8 = new Uint8Array(buf);
      chunks.push(u8);
      totalLength += u8.byteLength;
    }

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result.buffer;
  };

  return {
    id: nextId(),
    name,
    size,
    mimeHint: mime || undefined,
    path: undefined,
    readAll: (signal) => readRange(0, size, signal),
    readRange,
    url: async () => {
      if (!streamPromise) {
        streamPromise = streamUrl(name, size, (s, e) => readRange(s, e));
      }
      const stream = await streamPromise;
      if (closed) {
        try {
          stream.release();
        } catch {}
      } else {
        streamRelease = stream.release;
      }
      return stream.url;
    },
    release: () => {
      if (streamRelease) {
        try {
          streamRelease();
        } catch {}
        streamRelease = undefined;
      }
      if (!closed) {
        closed = true;
        fetch(`${base}/_uniview_shared/${token}?close=1`).catch(() => {});
      }
    },
  };
}
