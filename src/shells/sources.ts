import { extOf } from "../core/detect";
import type { FileSource } from "../core/types";

let counter = 0;
export const nextId = () => `f${Date.now().toString(36)}${(counter++).toString(36)}`;

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

const MEDIA_TYPES: Record<string, string> = {
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime",
  webm: "video/webm", mkv: "video/x-matroska", ogv: "video/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac",
  wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", weba: "audio/webm",
};

/** A media type for blob URLs. Browsers refuse to render SVG (and some media) from untyped blobs. */
export function mediaTypeFor(name: string): string | undefined {
  return MEDIA_TYPES[extOf(name)];
}

/** Wrap a browser Blob/File (drag-and-drop, file input, Capacitor picker). */
export function blobSource(blob: Blob, name: string, path?: string): FileSource {
  let url: string | undefined;
  return {
    id: nextId(),
    name,
    size: blob.size,
    mimeHint: blob.type || undefined,
    path,
    readAll: (signal) => abortable(blob.arrayBuffer(), signal),
    readRange: (start, end, signal) => abortable(blob.slice(start, end).arrayBuffer(), signal),
    url: async () => {
      if (url) return url;
      const type = mediaTypeFor(name);
      // Re-type only when the OS gave none or a generic one; slicing keeps the bytes on disk, no copy.
      const typed = type && (!blob.type || blob.type === "application/octet-stream") ? blob.slice(0, blob.size, type) : blob;
      return (url = URL.createObjectURL(typed));
    },
    release() {
      if (url) URL.revokeObjectURL(url);
      url = undefined;
    },
  };
}

/** Wrap bytes already in memory, such as a ZIP entry. */
export function memorySource(bytes: Uint8Array, name: string, mimeHint?: string): FileSource {
  const blob = new Blob([bytes as BlobPart], mimeHint ? { type: mimeHint } : undefined);
  return blobSource(blob, name);
}
