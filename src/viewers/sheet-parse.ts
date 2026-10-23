import * as XLSX from "xlsx";
import { CorruptFileError } from "../core/errors";
import { assertZipWithinBudget, decodeText } from "../core/zip";

export const DEFAULT_COL_W = 110;

export interface ParsedSheet {
  name: string;
  rows: number;
  cols: number;
  colWidths: number[];
  cells: string[][];
}

export interface ParseSpreadsheetOptions {
  ext?: string;
  by?: string;
}

/** Pure spreadsheet parsing: handles CSV/TSV with UTF-8 decoding and ZIP-based workbooks with budget checks. */
export function parseSpreadsheet(
  data: ArrayBuffer | Uint8Array,
  opts: ParseSpreadsheetOptions = {},
): ParsedSheet[] {
  const buf = data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (head[0] === 0x50 && head[1] === 0x4b) {
    assertZipWithinBudget(new Uint8Array(buf));
  }

  let wb: XLSX.WorkBook;
  try {
    const isText =
      opts.ext === "csv" ||
      opts.ext === "tsv" ||
      opts.by === "content" ||
      (!opts.ext && (head[0] !== 0x50 || head[1] !== 0x4b) && head[0] !== 0xd0);
    wb = isText
      ? XLSX.read(decodeText(new Uint8Array(buf)), {
          type: "string",
          dense: true,
          cellDates: true,
          raw: false,
          FS: opts.ext === "tsv" ? "\t" : undefined,
        })
      : XLSX.read(buf, {
          type: "array",
          dense: true,
          cellDates: true,
          cellStyles: false,
          sheetStubs: false,
        });
  } catch (err) {
    if (err instanceof CorruptFileError) throw err;
    throw new CorruptFileError(`This spreadsheet could not be read: ${(err as Error).message}`);
  }

  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    if (!ws) {
      return { name, rows: 0, cols: 0, colWidths: [], cells: [] };
    }
    const ref = ws["!ref"];
    const range = ref ? XLSX.utils.decode_range(ref) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
    const rows = Math.max(0, range.e.r - range.s.r + 1);
    const cols = Math.max(0, range.e.c - range.s.c + 1);
    const dense = (ws as unknown as { "!data"?: (XLSX.CellObject | undefined)[][] })["!data"];
    const colsList = ws["!cols"] ?? [];
    const widths = colsList.map((c) => (c?.wpx ? c.wpx : c?.wch ? c.wch * 7 + 10 : undefined));

    const colWidths: number[] = [];
    for (let c = 0; c < cols; c++) {
      const w = widths[c + range.s.c];
      colWidths.push(Math.max(40, Math.min(480, w ?? DEFAULT_COL_W)));
    }

    const cells: string[][] = [];
    for (let r = 0; r < rows; r++) {
      const row: string[] = [];
      const rr = r + range.s.r;
      const denseRow = dense ? dense[rr] : undefined;
      for (let c = 0; c < cols; c++) {
        const cc = c + range.s.c;
        const cell = denseRow ? denseRow[cc] : (dense ? undefined : ws[XLSX.utils.encode_cell({ r: rr, c: cc })]);
        if (!cell) {
          row.push("");
        } else if (cell.w !== undefined) {
          row.push(cell.w);
        } else if (cell.v === undefined || cell.v === null) {
          row.push("");
        } else {
          row.push(cell.v instanceof Date ? cell.v.toLocaleString() : String(cell.v));
        }
      }
      cells.push(row);
    }

    return {
      name,
      rows,
      cols,
      colWidths,
      cells,
    };
  });
}
