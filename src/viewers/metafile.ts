const MAX_SIZE = 32 * 1024 * 1024;
const MAX_DIM = 8000;
const MAX_PIXELS = 64_000_000;

function validateEmf(view: DataView): boolean {
  if (view.byteLength < 88) return false;
  if (view.getUint32(0, true) !== 1) return false; // type = EMR_HEADER
  if (view.getUint32(4, true) < 88) return false; // header size
  if (view.getUint32(40, true) !== 0x464d4520) return false; // signature ' EMF'
  const l = view.getInt32(8, true), t = view.getInt32(12, true);
  const r = view.getInt32(16, true), b = view.getInt32(20, true);
  const w = r - l, h = b - t;
  if (w <= 0 || h <= 0 || w > MAX_DIM || h > MAX_DIM) return false;
  return true;
}

function validateWmf(view: DataView): boolean {
  if (view.byteLength < 18) return false;
  if (view.getUint32(0, true) === 0x9ac6cdd7) { // placeable WMF
    if (view.byteLength < 22) return false;
    const l = view.getInt16(6, true), t = view.getInt16(8, true);
    const r = view.getInt16(10, true), b = view.getInt16(12, true);
    const w = r - l, h = b - t;
    if (w <= 0 || h <= 0) return false;
    const inch = view.getUint16(14, true);
    if (inch === 0) return false;
    const pw = (w * 96) / inch;
    const ph = (h * 96) / inch;
    if (!Number.isFinite(pw) || !Number.isFinite(ph) || pw <= 0 || ph <= 0) return false;
    if (pw > MAX_DIM || ph > MAX_DIM || pw * ph > MAX_PIXELS) return false;
    return true;
  }
  const fileType = view.getUint16(0, true);
  const headerSize = view.getUint16(2, true);
  return (fileType === 1 || fileType === 2) && headerSize === 9;
}

export async function metafileToPng(bytes: Uint8Array, kind: 'emf' | 'wmf'): Promise<Blob | null> {
  try {
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_SIZE) return null;
    if (kind !== 'emf' && kind !== 'wmf') return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const valid = kind === 'emf' ? validateEmf(view) : validateWmf(view);
    if (!valid) return null;

    const { convertMetafileToDataUrl } = await import('emf-converter');
    const dataUrl = await convertMetafileToDataUrl(new Uint8Array(bytes).buffer, {
      maxCanvasDimension: MAX_DIM,
      maxWidth: MAX_DIM,
      maxHeight: MAX_DIM,
      maxRecords: 100_000,
    });
    if (!dataUrl || typeof dataUrl !== 'string') return null;

    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return null;
    const binary = atob(dataUrl.slice(commaIdx + 1));
    const png = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) png[i] = binary.charCodeAt(i);

    if (png.length < 24) return null;
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 8; i++) if (png[i] !== sig[i]) return null;

    const pView = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const width = pView.getUint32(16, false);
    const height = pView.getUint32(20, false);
    if (width === 0 || height === 0 || width * height > MAX_PIXELS) return null;

    return new Blob([png], { type: 'image/png' });
  } catch {
    return null;
  }
}
