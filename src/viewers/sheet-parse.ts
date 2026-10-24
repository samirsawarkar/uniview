import * as XLSX from "xlsx";
import { CorruptFileError } from "../core/errors";
import { assertZipWithinBudget, decodeText } from "../core/zip";

export const DEFAULT_COL_W = 110;
export const MAX_GRID_SLOTS = 500_000;
export const MAX_GRID_COLS = 16_384;
export const MAX_PARSE_ROWS = 100_000;
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
  totalRows?: number;
  totalCols?: number;
  truncated?: boolean;
  rowsTruncated?: boolean;
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
  totalRows?: number;
  totalCols?: number;
  truncated?: boolean;
  rowsTruncated?: boolean;
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
  const isText =
    opts.ext === "csv" ||
    opts.ext === "tsv" ||
    opts.by === "content" ||
    (!opts.ext && (head[0] !== 0x50 || head[1] !== 0x4b) && head[0] !== 0xd0);

  try {
    const text = isText ? decodeText(new Uint8Array(buf)) : "";
    wb = isText
      ? XLSX.read(text, {
          type: "string",
          dense: true,
          cellDates: true,
          raw: false,
          sheetRows: MAX_PARSE_ROWS + 1,
          FS: opts.ext === "tsv" ? "\t" : undefined,
        })
      : XLSX.read(buf, {
          type: "array",
          dense: true,
          cellDates: true,
          cellStyles: true,
          sheetStubs: false,
          sheetRows: MAX_PARSE_ROWS,
        });
  } catch (err) {
    if (err instanceof CorruptFileError) throw err;
    throw new CorruptFileError(`This spreadsheet could not be read: ${(err as Error).message}`);
  }

  // Pre-flight validation & budget check across all sheets before any cells array is allocated.
  const plans: SheetPlan[] = [];
  let remainingBudget = MAX_GRID_SLOTS;
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

    const textRowsCapped = isText && rows > MAX_PARSE_ROWS;
    const availableRows = textRowsCapped ? MAX_PARSE_ROWS : rows;

    const rawFullref = (ws as { "!fullref"?: unknown })["!fullref"];
    let fullRows = availableRows;
    if (!isText) {
      if (typeof rawFullref === "string" && rawFullref.trim() !== "") {
        try {
          const fullRange = XLSX.utils.decode_range(rawFullref);
          if (
            Number.isFinite(fullRange.s.r) &&
            Number.isFinite(fullRange.e.r) &&
            fullRange.e.r >= fullRange.s.r
          ) {
            fullRows = fullRange.e.r - fullRange.s.r + 1;
          }
        } catch {
          // fallback to rows from !ref
        }
      } else if (rawFullref && typeof rawFullref === "object" && "s" in rawFullref && "e" in rawFullref) {
        const fr = rawFullref as XLSX.Range;
        if (Number.isFinite(fr.s.r) && Number.isFinite(fr.e.r) && fr.e.r >= fr.s.r) {
          fullRows = fr.e.r - fr.s.r + 1;
        }
      }
    }

    let keptCols = remainingBudget > 0 ? Math.min(cols, MAX_GRID_COLS, remainingBudget) : 0;
    let keptRows = keptCols > 0 ? Math.min(availableRows, Math.floor(remainingBudget / keptCols)) : 0;
    if (keptRows === 0) {
      keptCols = 0;
    }

    const usedSlots = keptRows * keptCols;
    remainingBudget = Math.max(0, remainingBudget - usedSlots);

    const colsDropped = keptRows > 0 && cols > keptCols;
    const rowsDropped = textRowsCapped || (fullRows > keptRows && fullRows > 0);
    const isTruncated = rowsDropped || colsDropped;

    let totalRows: number | undefined;
    if (textRowsCapped) {
      totalRows = undefined;
    } else if (fullRows > keptRows && fullRows > 0) {
      totalRows = fullRows;
    }

    const totalCols = colsDropped ? cols : undefined;

    // Conservative check of cell text content in this sheet before allocating output arrays
    if (keptRows > 0 && keptCols > 0) {
      const maxR = range.s.r + keptRows - 1;
      const maxC = range.s.c + keptCols - 1;
      const dense = (ws as unknown as { "!data"?: (XLSX.CellObject | undefined)[][] })["!data"];
      if (dense) {
        for (let r = range.s.r; r <= maxR && r < dense.length; r++) {
          const denseRow = dense[r];
          if (!denseRow) continue;
          for (let c = range.s.c; c <= maxC && c < denseRow.length; c++) {
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
          try {
            const coord = XLSX.utils.decode_cell(key);
            if (coord.r < range.s.r || coord.r > maxR || coord.c < range.s.c || coord.c > maxC) {
              continue;
            }
          } catch {
            continue;
          }
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
    }

    const rawMerges: XLSX.Range[] = ws["!merges"] ?? [];
    totalMerges += rawMerges.length;
    if (totalMerges > MAX_MERGES) {
      throw new CorruptFileError(
        `Spreadsheet exceeds maximum merge budget (${totalMerges.toLocaleString()} > ${MAX_MERGES.toLocaleString()} merges).`
      );
    }

    const merges: SheetMerge[] = [];
    if (keptRows > 0 && keptCols > 0) {
      const maxR = range.s.r + keptRows - 1;
      const maxC = range.s.c + keptCols - 1;
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
        const clipR1 = Math.min(r1, maxR);
        const clipC0 = Math.max(c0, range.s.c);
        const clipC1 = Math.min(c1, maxC);
        if (clipR0 > clipR1 || clipC0 > clipC1) {
          continue;
        }
        merges.push({
          s: { r: clipR0 - range.s.r, c: clipC0 - range.s.c },
          e: { r: clipR1 - range.s.r, c: clipC1 - range.s.c },
        });
      }
    }

    plans.push({ name, ws, range, rows: keptRows, cols: keptCols, merges, totalRows, totalCols, truncated: isTruncated, rowsTruncated: rowsDropped || undefined });
  }

  return plans.map(({ name, ws, range, rows, cols, merges, totalRows, totalCols, truncated, rowsTruncated }) => {
    if (!ws) {
      const emptySheet: ParsedSheet = { name, rows: 0, cols: 0, colWidths: [], cells: [], merges: [] };
      if (totalRows !== undefined) emptySheet.totalRows = totalRows;
      if (totalCols !== undefined) emptySheet.totalCols = totalCols;
      if (truncated) emptySheet.truncated = true;
      if (rowsTruncated) emptySheet.rowsTruncated = true;
      return emptySheet;
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

    const parsed: ParsedSheet = {
      name,
      rows,
      cols,
      colWidths,
      cells,
      merges,
    };
    if (totalRows !== undefined) parsed.totalRows = totalRows;
    if (totalCols !== undefined) parsed.totalCols = totalCols;
    if (truncated) parsed.truncated = true;
    if (rowsTruncated) parsed.rowsTruncated = true;
    return parsed;
  });
}
