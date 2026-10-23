import { useEffect, useRef, useState, type ReactNode } from "react";
import { TooLargeError, isAbort } from "../core/errors";
import type { FileSource } from "../core/types";
import { MAX_IN_MEMORY } from "./types";

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar" role="toolbar">{children}</div>;
}

export function Spacer() {
  return <div className="spacer" />;
}

export function Loading({ label = "Opening…" }: { label?: string }) {
  return (
    <div className="center-msg" role="status">
      <div className="spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

/**
 * Load something derived from a file once, with cancellation when the tab closes or the file changes.
 * Errors (other than aborts) are rethrown during render so the tab's error boundary shows them.
 */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]): T | undefined {
  const [state, setState] = useState<{ value?: T; error?: unknown; done: boolean }>({ done: false });
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const ctrl = new AbortController();
    setState({ done: false });
    loadRef.current(ctrl.signal).then(
      (value) => !ctrl.signal.aborted && setState({ value, done: true }),
      (error) => !ctrl.signal.aborted && !isAbort(error) && setState({ error, done: true }),
    );
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  if (state.error) throw state.error;
  return state.done ? state.value : undefined;
}

/** Read a whole file, refusing sizes an in-memory parser cannot handle safely. */
export async function readAllChecked(source: FileSource, signal: AbortSignal, limit = MAX_IN_MEMORY): Promise<ArrayBuffer> {
  if (source.size > limit) throw new TooLargeError(limit);
  return source.readAll(signal);
}

/** Fire onReady after the browser has painted the first content. */
export function useReady(ready: boolean, onReady: () => void): void {
  const fired = useRef(false);
  useEffect(() => {
    if (!ready || fired.current) return;
    fired.current = true;
    requestAnimationFrame(() => requestAnimationFrame(onReady));
  }, [ready, onReady]);
}

/**
 * Listen to cancellable back events on window while active/enabled.
 * Prevents default if not already prevented and invokes the callback.
 */
export function useViewerBack(enabled: boolean, onBack: () => void): void {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: Event) => {
      if (!e.defaultPrevented) {
        e.preventDefault();
        onBackRef.current();
      }
    };
    window.addEventListener("uniview:back:viewer", handler);
    return () => window.removeEventListener("uniview:back:viewer", handler);
  }, [enabled]);
}
