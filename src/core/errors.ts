/** Errors a viewer throws so the tab can explain what happened and offer a fallback view. */
export class ViewerError extends Error {
  constructor(
    message: string,
    readonly code: "unsupported" | "corrupt" | "too-large" | "access-denied" | "aborted",
  ) {
    super(message);
    this.name = "ViewerError";
  }
}

export class UnsupportedFormatError extends ViewerError {
  constructor(message: string) {
    super(message, "unsupported");
  }
}

export class CorruptFileError extends ViewerError {
  constructor(message: string) {
    super(message, "corrupt");
  }
}

export class TooLargeError extends ViewerError {
  constructor(readonly limit: number) {
    super(`This file is larger than ${formatBytes(limit)}, the most this view can load at once.`, "too-large");
  }
}

export class AccessDeniedError extends ViewerError {
  constructor(message = "UniView is not allowed to read this file.") {
    super(message, "access-denied");
  }
}

export function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof ViewerError && err.code === "aborted")
  );
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

export function formatBytes(n: number): string {
  if (n < 0 || !Number.isFinite(n)) return "unknown size";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
