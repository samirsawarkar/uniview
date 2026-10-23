// Cancellation paths (Codex re-review: "cancellation coverage is insufficient").
import { describe, expect, it, vi } from "vitest";
import { loadFont, loadPdf, type PdfTask } from "../../src/viewers/loaders";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

describe("loadPdf", () => {
  it("never starts pdf.js when the tab closes during the read", async () => {
    const read = deferred<ArrayBuffer>();
    const open = vi.fn();
    const ctrl = new AbortController();
    const p = loadPdf(() => read.promise, open, ctrl.signal);
    ctrl.abort();
    read.resolve(new ArrayBuffer(4));
    await expect(p).rejects.toSatisfy(isAbort);
    expect(open).not.toHaveBeenCalled();
  });

  it("destroys the task when the tab closes while the document loads", async () => {
    const docP = deferred<string>();
    const destroy = vi.fn();
    const task: PdfTask<string> = { promise: docP.promise, destroy };
    const ctrl = new AbortController();
    const p = loadPdf(async () => new ArrayBuffer(4), () => task, ctrl.signal);
    await Promise.resolve();
    await Promise.resolve();
    ctrl.abort();
    expect(destroy).toHaveBeenCalledTimes(1);
    docP.resolve("doc");
    await expect(p).rejects.toSatisfy(isAbort);
  });

  it("returns the document and leaves it alive when not cancelled", async () => {
    const destroy = vi.fn();
    const r = await loadPdf(async () => new ArrayBuffer(4), () => ({ promise: Promise.resolve("doc"), destroy }), new AbortController().signal);
    expect(r.doc).toBe("doc");
    expect(destroy).not.toHaveBeenCalled();
  });
});

describe("loadFont", () => {
  it("does not register a font whose tab closed while it loaded", async () => {
    const loading = deferred<void>();
    const face = { load: () => loading.promise.then(() => face) } as unknown as FontFace;
    const fonts = { add: vi.fn() };
    const ctrl = new AbortController();
    const p = loadFont(async () => new ArrayBuffer(4), () => face, fonts, ctrl.signal);
    await Promise.resolve();
    ctrl.abort();
    loading.resolve();
    await expect(p).rejects.toSatisfy(isAbort);
    expect(fonts.add).not.toHaveBeenCalled();
  });

  it("registers the font when the tab stays open", async () => {
    const face = { load: async () => face } as unknown as FontFace;
    const fonts = { add: vi.fn() };
    await loadFont(async () => new ArrayBuffer(4), () => face, fonts, new AbortController().signal);
    expect(fonts.add).toHaveBeenCalledWith(face);
  });
});
