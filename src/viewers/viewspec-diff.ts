import { structuredPatch } from "diff";

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export type DiffResult =
  | { kind: "diff"; hunks: Hunk[] }
  | { kind: "too_big" };

export interface DiffOptions {
  timeoutMs: number;
  maxLines?: number;
  now?: () => number;
}

export function computeLineDiff(
  before: string,
  after: string,
  opts: DiffOptions
): DiffResult {
  const maxLines = opts.maxLines ?? 20_000;
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  if (beforeLines.length > maxLines || afterLines.length > maxLines) {
    return { kind: "too_big" };
  }

  const getNow = opts.now ?? (() => Date.now());
  const startTime = getNow();

  try {
    const patch = structuredPatch("", "", before, after, "", "", {
      timeout: opts.timeoutMs,
    });

    if (!patch || getNow() - startTime > opts.timeoutMs) {
      return { kind: "too_big" };
    }

    return { kind: "diff", hunks: patch.hunks };
  } catch {
    return { kind: "too_big" };
  }
}

export function parseUnified(text: string): Hunk[] {
  const lines = text.split("\n");
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;
  const headerRegex = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = headerRegex.exec(line);
    if (match) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      currentHunk = {
        oldStart: parseInt(match[1]!, 10),
        oldLines: match[2] !== undefined ? parseInt(match[2]!, 10) : 1,
        newStart: parseInt(match[3]!, 10),
        newLines: match[4] !== undefined ? parseInt(match[4]!, 10) : 1,
        lines: [],
      };
      continue;
    }

    if (currentHunk) {
      if (
        line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith(" ") ||
        line.startsWith("\\")
      ) {
        currentHunk.lines.push(line);
      } else if (line === "" && i < lines.length - 1) {
        currentHunk.lines.push(" ");
      }
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
}

export async function runDiff(
  before: string,
  after: string,
  opts: DiffOptions
): Promise<DiffResult> {
  if (typeof Worker === "undefined") {
    return computeLineDiff(before, after, opts);
  }

  return new Promise((resolve) => {
    let worker: Worker | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (worker) {
        worker.terminate();
        worker = null;
      }
    };

    try {
      worker = new Worker(
        new URL("./viewspec-diff.worker.ts", import.meta.url),
        { type: "module" }
      );

      timer = setTimeout(() => {
        cleanup();
        resolve({ kind: "too_big" });
      }, opts.timeoutMs + 200);

      worker.onmessage = (e: MessageEvent<{ result: DiffResult }>) => {
        cleanup();
        resolve(e.data.result);
      };

      worker.onerror = () => {
        cleanup();
        resolve({ kind: "too_big" });
      };

      worker.postMessage({ id: 1, before, after, opts });
    } catch {
      cleanup();
      resolve(computeLineDiff(before, after, opts));
    }
  });
}
