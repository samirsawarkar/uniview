/** Cancellation-aware loaders, separated from the viewers so their cleanup paths can be unit-tested. */

const aborted = () => new DOMException("Aborted", "AbortError");

export interface PdfTask<D> {
  promise: Promise<D>;
  destroy(): Promise<void> | void;
}

/**
 * Read the bytes, then start pdf.js. A read that finishes after the tab closed never starts a worker,
 * and a document that finishes loading after the tab closed is destroyed instead of returned.
 */
export async function loadPdf<D>(
  read: (signal: AbortSignal) => Promise<ArrayBuffer>,
  open: (data: Uint8Array) => PdfTask<D>,
  signal: AbortSignal,
): Promise<{ doc: D; task: PdfTask<D> }> {
  const data = new Uint8Array(await read(signal));
  if (signal.aborted) throw aborted();
  const task = open(data);
  const onAbort = () => void task.destroy();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const doc = await task.promise;
    if (signal.aborted) throw aborted();
    return { doc, task };
  } catch (err) {
    if (signal.aborted) throw aborted();
    throw err;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export interface FontSetLike {
  add(face: FontFace): unknown;
}

/** Load a font face and register it only if the tab is still open, so a closed tab never leaves a font behind. */
export async function loadFont(
  read: (signal: AbortSignal) => Promise<ArrayBuffer>,
  makeFace: (buf: ArrayBuffer) => FontFace,
  fonts: FontSetLike,
  signal: AbortSignal,
): Promise<FontFace> {
  const buf = await read(signal);
  if (signal.aborted) throw aborted();
  const face = makeFace(buf);
  await face.load();
  if (signal.aborted) throw aborted();
  fonts.add(face);
  return face;
}
