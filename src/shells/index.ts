import type { ShellBridge } from "../core/types";
import { createElectronBridge, hasElectronApi } from "./electron";
import { createWebBridge } from "./web";
import { blobSource } from "./sources";
import { capacitorTransport } from "./capacitor-transport";
import { sharedSource } from "./native-shared";

let bridge: ShellBridge | undefined;

function isCapacitor(): boolean {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

/** The one ShellBridge for this runtime. Viewers and UI never import a shell directly. */
export function getBridge(): ShellBridge {
  if (bridge) return bridge;
  if (hasElectronApi()) bridge = createElectronBridge();
  else if (isCapacitor()) {
    bridge = createWebBridge("capacitor");
    bridge.remoteTransport = capacitorTransport;
    bridge.canScanQr = !!navigator.mediaDevices?.getUserMedia;
  } else bridge = createWebBridge("web");
  installNativeOpenHook();
  return bridge;
}

/**
 * Android/iOS hand files to the page through window.__univiewOpenUrl(url, name, mime), where url is a
 * same-origin Capacitor file URL for a private copy the native side made from the VIEW/SEND intent.
 */
export function installNativeOpenHook(): void {
  const w = window as unknown as {
    __univiewOpenUrl?: (url: string, name: string, mime?: string) => Promise<void>;
    __univiewOpenShared?: (token: string, name: string, size: number, mime: string) => void;
    __univiewOpen?: (files: unknown[]) => void;
    __univiewOpenError?: (message: string) => void;
    __univiewPending?: { url: string; name: string; mime?: string }[];
    __univiewPendingShared?: { token: string; name: string; size: number; mime: string }[];
    __univiewPendingErrors?: string[];
  };
  w.__univiewOpenUrl = async (url, name, mime) => {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        w.__univiewOpenError?.(`Could not open "${name}". The shared file could not be read.`);
        return;
      }
      const blob = await res.blob();
      w.__univiewOpen?.([blobSource(mime && !blob.type ? new Blob([blob], { type: mime }) : blob, name)]);
    } catch {
      w.__univiewOpenError?.(`Could not open "${name}". The shared file could not be read.`);
    }
  };
  w.__univiewOpenShared = (token, name, size, mime) => {
    try {
      w.__univiewOpen?.([sharedSource(token, name, size, mime)]);
    } catch {
      w.__univiewOpenError?.(`Could not open "${name}".`);
    }
  };
  // Files that arrived before the page finished loading.
  const pending = w.__univiewPending ?? [];
  w.__univiewPending = [];
  for (const p of pending) void w.__univiewOpenUrl(p.url, p.name, p.mime);

  const pendingShared = w.__univiewPendingShared ?? [];
  w.__univiewPendingShared = [];
  for (const p of pendingShared) w.__univiewOpenShared(p.token, p.name, p.size, p.mime);

  // Errors that arrived before the page finished loading.
  const pendingErrors = w.__univiewPendingErrors ?? [];
  w.__univiewPendingErrors = [];
  for (const err of pendingErrors) {
    w.__univiewOpenError?.(err);
  }
}
