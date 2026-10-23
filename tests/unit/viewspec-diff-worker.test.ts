import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runDiff, computeLineDiff, type DiffResult } from "../../src/viewers/viewspec-diff";

class FakeWorker {
  static instances: FakeWorker[] = [];
  url: string | URL;
  options?: WorkerOptions;
  onmessage: ((e: MessageEvent<{ result: DiffResult }>) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  postedMessages: any[] = [];
  terminated = false;

  constructor(url: string | URL, options?: WorkerOptions) {
    this.url = url;
    this.options = options;
    FakeWorker.instances.push(this);
  }

  postMessage(msg: any) {
    this.postedMessages.push(msg);
  }

  terminate() {
    this.terminated = true;
  }
}

describe("runDiff worker behaviour", () => {
  const originalWorker = globalThis.Worker;

  beforeEach(() => {
    FakeWorker.instances = [];
    (globalThis as any).Worker = FakeWorker;
  });

  afterEach(() => {
    (globalThis as any).Worker = originalWorker;
    vi.useRealTimers();
  });

  it("resolves with worker result and terminates worker on result message", async () => {
    // Catches mutation where worker.onmessage is removed or worker is not terminated
    const expectedResult: DiffResult = {
      kind: "diff",
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-old", "+new"],
        },
      ],
    };

    const diffPromise = runDiff("old", "new", { timeoutMs: 1000 });

    expect(FakeWorker.instances.length).toBe(1);
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error("Worker not created");
    expect(worker.postedMessages.length).toBe(1);
    expect(worker.postedMessages[0]).toEqual({
      id: 1,
      before: "old",
      after: "new",
      opts: { timeoutMs: 1000 },
    });

    worker.onmessage?.({
      data: { result: expectedResult },
    } as MessageEvent<{ result: DiffResult }>);

    const result = await diffPromise;
    expect(result).toEqual(expectedResult);
    expect(worker.terminated).toBe(true);
  });

  it(
    "resolves too_big and terminates worker when watchdog timer fires",
    async () => {
      // Catches mutation where watchdog timer in runDiff is removed or does not terminate
      vi.useFakeTimers();

      const timeoutMs = 500;
      const diffPromise = runDiff("before", "after", { timeoutMs });

      expect(FakeWorker.instances.length).toBe(1);
      const worker = FakeWorker.instances[0];
      if (!worker) throw new Error("Worker not created");

      await vi.advanceTimersByTimeAsync(timeoutMs + 100);
      expect(worker.terminated).toBe(false);

      await vi.advanceTimersByTimeAsync(100);

      const result = await diffPromise;
      expect(result).toEqual({ kind: "too_big" });
      expect(worker.terminated).toBe(true);
    },
    2000
  );

  it("resolves too_big and terminates worker on worker onerror", async () => {
    // Catches mutation where worker.onerror handler is removed or worker is not terminated
    const diffPromise = runDiff("before", "after", { timeoutMs: 1000 });

    expect(FakeWorker.instances.length).toBe(1);
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error("Worker not created");

    worker.onerror?.(new Error("Worker failed to load"));

    const result = await diffPromise;
    expect(result).toEqual({ kind: "too_big" });
    expect(worker.terminated).toBe(true);
  });

  it("falls back to in-thread result when Worker constructor throws", async () => {
    // Catches mutation where Worker constructor exception is unhandled or fails to fallback
    (globalThis as any).Worker = class ThrowingWorker {
      constructor() {
        throw new Error("Worker not allowed");
      }
    };

    const before = "line1\nline2";
    const after = "line1\nline2_modified";
    const expected = computeLineDiff(before, after, { timeoutMs: 1000 });

    const result = await runDiff(before, after, { timeoutMs: 1000 });
    expect(result).toEqual(expected);
  });

  it("returns in-thread computeLineDiff result when Worker is undefined", async () => {
    // Catches mutation where typeof Worker === 'undefined' check is removed
    delete (globalThis as any).Worker;

    const before = "alpha\nbeta";
    const after = "alpha\ngamma";
    const expected = computeLineDiff(before, after, { timeoutMs: 1000 });

    const result = await runDiff(before, after, { timeoutMs: 1000 });
    expect(result).toEqual(expected);
  });
});
