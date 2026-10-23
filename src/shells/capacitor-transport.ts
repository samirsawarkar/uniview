import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import type { RemoteTransport } from "../core/types";
import { validateLanUrl } from "./lan-address";

export interface LanHttpPlugin {
  post(options: {
    url: string;
    body: string;
    contentType: string;
    connectTimeoutMs: number;
    readTimeoutMs: number;
    deadlineMs: number;
    maxResponseBytes: number;
  }): Promise<{ status: number; body: string }>;
}

let lanHttp: LanHttpPlugin | undefined;

/** The bounded native LAN HTTP plugin on Android; null elsewhere (iOS keeps CapacitorHttp). */
function androidLanHttp(): LanHttpPlugin | null {
  try {
    if (Capacitor.getPlatform() !== "android") return null;
    lanHttp ??= registerPlugin<LanHttpPlugin>("LanHttp");
    return lanHttp;
  } catch {
    return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out[i] = code;
  }
  return out;
}

/**
 * Native HTTP for Android/iOS: requests leave from the app process, not the WebView, so the page CSP stays
 * closed to the network. Bodies cross the bridge as base64.
 */
export const capacitorTransport: RemoteTransport = async (host, port, path, body, contentType, opts) => {
  const url = validateLanUrl(host, port, path);

  const LanHttp = androidLanHttp();

  if (LanHttp) {
    const connectTimeoutMs = opts?.timeoutMs ?? 4000;
    const readTimeoutMs = opts?.timeoutMs ?? 20000;
    const deadlineMs = opts?.timeoutMs !== undefined ? opts.timeoutMs + 500 : 30000;
    const maxResponseBytes = 8 * 1024 * 1024 + 64 * 1024;

    const res = await LanHttp.post({
      url,
      body: toBase64(body),
      contentType,
      connectTimeoutMs,
      readTimeoutMs,
      deadlineMs,
      maxResponseBytes,
    });

    if (res.status >= 300 && res.status < 400) {
      throw new Error(`LAN-only transport: HTTP redirect (${res.status}) rejected`);
    }

    return { status: res.status, body: fromBase64(res.body) };
  }

  // Capacitor Android's CapacitorHttpUrlConnection writes data as a literal string for application/json,
  // which sends raw base64 instead of binary bytes. Only for non-JSON with dataType: "file" does it
  // base64-decode into raw bytes. We always send application/octet-stream so bodies arrive decoded.
  const res = await CapacitorHttp.request({
    url,
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    data: toBase64(body),
    dataType: "file",
    responseType: "arraybuffer",
    connectTimeout: opts?.timeoutMs ?? 4000,
    readTimeout: opts?.timeoutMs ?? 20000,
    disableRedirects: true,
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`LAN-only transport: HTTP redirect (${res.status}) rejected`);
  }
  const data = res.data;
  const bytes = typeof data === "string" ? fromBase64(data) : new TextEncoder().encode(JSON.stringify(data ?? null));
  return { status: res.status, body: bytes };
};
