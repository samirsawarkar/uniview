// Streaming remote media to <video>/<audio>: a service worker turns range requests for
// /__uniview_stream/<id>/<name> into requests to this page, which answers with decrypted bytes.
import { mediaTypeFor } from "../shells/sources";

type Reader = (start: number, end: number) => Promise<ArrayBuffer>;

const streams = new Map<string, { size: number; type: string; read: Reader }>();
let ready: Promise<boolean> | null = null;
/** Largest slice answered for an open-ended range; the media element asks again for more. */
const SLICE = 2 * 1024 * 1024;

function swSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && window.isSecureContext;
}

function ensureWorker(): Promise<boolean> {
  ready ??= (async () => {
    if (!swSupported()) return false;
    try {
      await navigator.serviceWorker.register(new URL("uniview-sw.js", document.baseURI), { scope: "./" });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        // First install: wait for the worker to take control of this page (it calls clients.claim()).
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 3000);
          navigator.serviceWorker.addEventListener("controllerchange", () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });
      }
      navigator.serviceWorker.addEventListener("message", onWorkerMessage);
      return !!navigator.serviceWorker.controller;
    } catch {
      return false;
    }
  })();
  return ready;
}

async function onWorkerMessage(e: MessageEvent) {
  const msg = e.data as { type?: string; id?: string; start?: number; end?: number | null };
  const port = e.ports[0];
  if (msg?.type !== "uniview-stream-read" || !port) return;
  const s = streams.get(String(msg.id));
  if (!s) return port.postMessage({ status: 404 });
  const start = Math.max(0, Number(msg.start) || 0);
  if (start >= s.size) return port.postMessage({ status: 416, size: s.size });
  const end = Math.min(s.size, msg.end == null ? start + SLICE : Math.min(Number(msg.end) + 1, start + 8 * SLICE));
  try {
    const bytes = await s.read(start, end);
    port.postMessage({ status: 206, start, end: start + bytes.byteLength - 1, size: s.size, type: s.type, bytes }, [bytes]);
  } catch (err) {
    port.postMessage({ status: 502, error: String((err as Error).message) });
  }
}

/**
 * A URL a media element can play while downloading only what it needs. Falls back to assembling a Blob
 * (whole download) where service workers are unavailable, such as iOS WKWebView.
 */
export async function streamUrl(name: string, size: number, read: Reader): Promise<{ url: string; release: () => void }> {
  const type = mediaTypeFor(name) ?? "application/octet-stream";
  if (await ensureWorker()) {
    const id = crypto.randomUUID();
    streams.set(id, { size, type, read });
    return { url: new URL(`__uniview_stream/${id}/${encodeURIComponent(name)}`, document.baseURI).href, release: () => streams.delete(id) };
  }
  const bytes = await read(0, size);
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  return { url, release: () => URL.revokeObjectURL(url) };
}
