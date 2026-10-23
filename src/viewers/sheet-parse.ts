import * as XLSX from "xlsx";
import { CorruptFileError } from "../core/errors";
import { assertZipWithinBudget, decodeText } from "../core/zip";

export const DEFAULT_COL_W = 110;
export const MAX_GRID_SLOTS = 500_000;
export const MAX_OUTPUT_CHARS = 32 * 1024 * 1024; // 32 Mi UTF-16 code units
export const MAX_OUTPUT_CODE_UNITS = MAX_OUTPUT_CHARS;
export const MAX_MERGES = 10_000;

export interface SheetMerge {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

export interface ParsedSheet {
  name: string;
  rows: number;
  cols: number;
  colWidths: number[];
  cells: string[][];
  merges: SheetMerge[];
}

export interface ParseSpreadsheetOptions {
  ext?: string;
  by?: string;
}

function formatCell(cell: XLSX.CellObject | undefined): string {
  if (!cell) {
    return "";
  }
  if (cell.w !== undefined) {
    return cell.w;
  }
  if (cell.v === undefined || cell.v === null) {
    return "";
  }
  return cell.v instanceof Date ? cell.v.toLocaleString() : String(cell.v);
}

interface SheetPlan {
  name: string;
  ws: XLSX.WorkSheet | undefined;
  range: XLSX.Range;
  rows: number;
  cols: number;
  merges: SheetMerge[];
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
          cellStyles: true,
          sheetStubs: false,
        });
  } catch (err) {
    if (err instanceof CorruptFileError) throw err;
    throw new CorruptFileError(`This spreadsheet could not be read: ${(err as Error).message}`);
  }

  // Pre-flight validation & budget check across all sheets before any cells array is allocated.
  const plans: SheetPlan[] = [];
  let totalGridSlots = 0;
  let totalTextUnits = 0;
  let totalMerges = 0;

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) {
      plans.push({
        name,
        ws: undefined,
        range: { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } },
        rows: 0,
        cols: 0,
        merges: [],
      });
      continue;
    }

    const ref = ws["!ref"];
    let range: XLSX.Range;
    if (ref === undefined) {
      range = { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
    } else {
      if (typeof ref !== "string" || ref.trim() === "") {
        throw new CorruptFileError(`Spreadsheet sheet "${name}" has an invalid range specification.`);
      }
      try {
        range = XLSX.utils.decode_range(ref);
      } catch (err) {
        throw new CorruptFileError(`Spreadsheet sheet "${name}" has an unparseable range: ${(err as Error).message}`);
      }
    }

    if (
      !Number.isFinite(range.s.r) ||
      !Number.isFinite(range.s.c) ||
      !Number.isFinite(range.e.r) ||
      !Number.isFinite(range.e.c) ||
      !Number.isInteger(range.s.r) ||
      !Number.isInteger(range.s.c) ||
      !Number.isInteger(range.e.r) ||
      !Number.isInteger(range.e.c) ||
      range.s.r < 0 ||
      range.s.c < 0 ||
      range.e.r < -1 ||
      range.e.c < -1
    ) {
      throw new CorruptFileError(`Spreadsheet sheet "${name}" has an invalid or non-finite range.`);
    }

    if (ref !== undefined && (range.e.r < range.s.r || range.e.c < range.s.c)) {
      throw new CorruptFileError(`Spreadsheet sheet "${name}" has an invalid inverted range.`);
    }

    const rows = range.e.r >= range.s.r ? range.e.r - range.s.r + 1 : 0;
    const cols = range.e.c >= range.s.c ? range.e.c - range.s.c + 1 : 0;

    if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 0 || cols < 0) {
      throw new CorruptFileError(`Spreadsheet sheet "${name}" has invalid dimensions.`);
    }

    const sheetSlots = rows * cols;
    if (!Number.isSafeInteger(sheetSlots) || sheetSlots < 0) {
      throw new CorruptFileError(`Spreadsheet sheet "${name}" exceeds grid slot capacity.`);
    }

    totalGridSlots += sheetSlots;
    if (totalGridSlots > MAX_GRID_SLOTS) {
      throw new CorruptFileError(
        `Spreadsheet exceeds maximum grid slot budget (${totalGridSlots.toLocaleString()} > ${MAX_GRID_SLOTS.toLocaleString()} slots).`
      );
    }

    // Conservative check of cell text content in this sheet before allocating output arrays
    const dense = (ws as unknown as { "!data"?: (XLSX.CellObject | undefined)[][] })["!data"];
    if (dense) {
      for (let r = range.s.r; r <= range.e.r && r < dense.length; r++) {
        const denseRow = dense[r];
        if (!denseRow) continue;
        for (let c = range.s.c; c <= range.e.c && c < denseRow.length; c++) {
          const cell = denseRow[c];
          if (!cell) continue;
          totalTextUnits += formatCell(cell).length;
          if (totalTextUnits > MAX_OUTPUT_CHARS) {
            throw new CorruptFileError(
              `Spreadsheet text content exceeds output budget (${MAX_OUTPUT_CHARS.toLocaleString()} UTF-16 code units).`
            );
          }
        }
      }
    } else {
      for (const key of Object.keys(ws)) {
        if (key.charCodeAt(0) === 0x21 /* '!' */) continue;
        const cell = ws[key] as XLSX.CellObject | undefined;
        if (!cell) continue;
        totalTextUnits += formatCell(cell).length;
        if (totalTextUnits > MAX_OUTPUT_CHARS) {
          throw new CorruptFileError(
            `Spreadsheet text content exceeds output budget (${MAX_OUTPUT_CHARS.toLocaleString()} UTF-16 code units).`
          );
        }
      }
    }

    const rawMerges: XLSX.Range[] = ws["!merges"] ?? [];
    totalMerges += rawMerges.length;
    if (totalMerges > MAX_MERGES) {
      throw new CorruptFileError(
        `Spreadsheet exceeds maximum merge budget (${totalMerges.toLocaleString()} > ${MAX_MERGES.toLocaleString()} merges).`
      );
    }

    const merges: SheetMerge[] = [];
    if (rows > 0 && cols > 0) {
      for (const m of rawMerges) {
        if (!m || !m.s || !m.e) continue;
        const r0 = Math.min(m.s.r, m.e.r);
        const r1 = Math.max(m.s.r, m.e.r);
        const c0 = Math.min(m.s.c, m.e.c);
        const c1 = Math.max(m.s.c, m.e.c);
        if (
          !Number.isFinite(r0) ||
          !Number.isFinite(r1) ||
          !Number.isFinite(c0) ||
          !Number.isFinite(c1)
        ) {
          continue;
        }
        const clipR0 = Math.max(r0, range.s.r);
        const clipR1 = Math.min(r1, range.e.r);
        const clipC0 = Math.max(c0, range.s.c);
        const clipC1 = Math.min(c1, range.e.c);
        if (clipR0 > clipR1 || clipC0 > clipC1) {
          continue;
        }
        merges.push({
          s: { r: clipR0 - range.s.r, c: clipC0 - range.s.c },
          e: { r: clipR1 - range.s.r, c: clipC1 - range.s.c },
        });
      }
    }

    plans.push({ name, ws, range, rows, cols, merges });
  }

  return plans.map(({ name, ws, range, rows, cols, merges }) => {
    if (!ws) {
      return { name, rows: 0, cols: 0, colWidths: [], cells: [], merges: [] };
    }

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
        row.push(formatCell(cell));
      }
      cells.push(row);
    }

    return {
      name,
      rows,
      cols,
      colWidths,
      cells,
      merges,
    };
  });
}
