import { parseSpreadsheet, type ParsedSheet } from "./sheet-parse";

export interface SheetWorkerRequest {
  id: number;
  buffer: ArrayBuffer;
  options: { ext?: string; by?: string };
}

export type SheetWorkerResponse =
  | { id: number; ok: true; sheets: ParsedSheet[] }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<SheetWorkerRequest>) => void) | null;
  postMessage: (message: SheetWorkerResponse) => void;
};

ctx.onmessage = (e: MessageEvent<SheetWorkerRequest>) => {
  const { id, buffer, options } = e.data;
  try {
    const sheets = parseSpreadsheet(buffer, options);
    ctx.postMessage({ id, ok: true, sheets });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: (err as Error).message });
  }
};
