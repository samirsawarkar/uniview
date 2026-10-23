import { CapacitorHttp } from "@capacitor/core";
import type { RemoteTransport } from "../core/types";

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Native HTTP for Android/iOS: requests leave from the app process, not the WebView, so the page CSP stays
 * closed to the network. Bodies cross the bridge as base64.
 */
export const capacitorTransport: RemoteTransport = async (host, port, path, body, contentType) => {
  const h = host.includes(":") ? `[${host}]` : host;
  const res = await CapacitorHttp.request({
    url: `http://${h}:${port}${path}`,
    method: "POST",
    headers: { "Content-Type": contentType },
    data: toBase64(body),
    dataType: "file",
    responseType: "arraybuffer",
    connectTimeout: 8000,
    readTimeout: 20000,
  });
  const data = res.data;
  const bytes = typeof data === "string" ? fromBase64(data) : new TextEncoder().encode(JSON.stringify(data ?? null));
  return { status: res.status, body: bytes };
};
