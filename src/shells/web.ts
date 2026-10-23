import type { FileSource, ShellBridge } from "../core/types";
import { blobSource } from "./sources";

/** Show the browser file picker. Resolves to [] if the user cancels. */
export function pickWithInput(): Promise<FileSource[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    input.setAttribute("data-testid", "file-input");
    let settled = false;
    const finish = (files: FileSource[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish(Array.from(input.files ?? []).map((f) => blobSource(f, f.name))));
    input.addEventListener("cancel", () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

export function createWebBridge(kind: "web" | "capacitor" = "web"): ShellBridge {
  const listeners = new Set<(files: FileSource[]) => void>();
  // Files handed over before the UI subscribed (a share intent at cold start) wait here.
  const queued: FileSource[][] = [];
  // Let platform glue (Capacitor intents, tests) hand files to the app.
  (window as unknown as { __univiewOpen?: (files: FileSource[]) => void }).__univiewOpen = (files) => {
    if (!listeners.size) queued.push(files);
    for (const l of listeners) l(files);
  };

  const errorListeners = new Set<(message: string) => void>();
  const queuedErrors: string[] = [];
  (window as unknown as { __univiewOpenError?: (message: string) => void }).__univiewOpenError = (message) => {
    if (!errorListeners.size) queuedErrors.push(message);
    for (const l of errorListeners) l(message);
  };

  return {
    kind,
    pickFiles: pickWithInput,
    onExternalOpen(cb) {
      listeners.add(cb);
      for (const files of queued.splice(0)) cb(files);
      return () => listeners.delete(cb);
    },
    onExternalOpenError(cb) {
      errorListeners.add(cb);
      for (const msg of queuedErrors.splice(0)) cb(msg);
      return () => errorListeners.delete(cb);
    },
  };
}
