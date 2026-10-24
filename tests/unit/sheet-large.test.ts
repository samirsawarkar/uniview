import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { parseSpreadsheet } from "../../src/viewers/sheet-parse";

/** A dense workbook (every cell filled), like a real export. */
function denseWorkbook(rows: number, cols: number): ArrayBuffer {
  const aoa = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => r * cols + c));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Sheet1");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

/** A tiny workbook whose worksheet XML declares a forged dimension (SheetJS's writer would clamp it). */
function forgedDimensionWorkbook(ref: string): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["left"]]), "Wide");
  const files = unzipSync(new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer));
  const name = "xl/worksheets/sheet1.xml";
  files[name] = strToU8(strFromU8(files[name]!).replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="${ref}"/>`));
  return zipSync(files);
}

describe("large spreadsheet truncation", { timeout: 60_000 }, () => {
  // Mutation caught: workbook truncation losing totalRows or truncated flag
  it("truncates 120,000 x 10 workbook to 50,000 rows with totalRows 120,000", () => {
    const parsed = parseSpreadsheet(denseWorkbook(120_000, 10), { ext: "xlsx" });
    expect(parsed[0]?.rows).toBe(50_000);
    expect(parsed[0]?.cols).toBe(10);
    expect(parsed[0]?.cells.length).toBe(50_000);
    expect(parsed[0]?.cells[49_999]?.[9]).toBe(String(49_999 * 10 + 9));
    expect(parsed[0]?.totalRows).toBe(120_000);
    expect(parsed[0]?.truncated).toBe(true);
  });

  // Mutation caught: incorrectly truncating sheets that fit slot budget
  it("keeps all rows for 60,000 x 5 workbook without truncation", () => {
    const ws: XLSX.WorkSheet = {
      "!ref": XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 59_999, c: 4 } }),
      A1: { t: "s", v: "top" },
      E60000: { t: "s", v: "bot" },
    };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

    const parsed = parseSpreadsheet(buf, { ext: "xlsx" });
    expect(parsed[0]?.rows).toBe(60_000);
    expect(parsed[0]?.cols).toBe(5);
    expect(parsed[0]?.totalRows).toBeUndefined();
    expect(parsed[0]?.truncated).toBeUndefined();
  });

  // Mutation caught: failure to cap at MAX_PARSE_ROWS (100,000) for workbooks
  it("truncates 150,000 x 2 workbook to 100,000 rows with totalRows 150,000", () => {
    const parsed = parseSpreadsheet(denseWorkbook(150_000, 2), { ext: "xlsx" });
    expect(parsed[0]?.rows).toBe(100_000);
    expect(parsed[0]?.totalRows).toBe(150_000);
    expect(parsed[0]?.truncated).toBe(true);
  });

  // Mutation caught: multi-sheet budget tracking error across sheets
  it("handles two sheets 40,000 x 10 then 30,000 x 10", () => {
    const ws1: XLSX.WorkSheet = {
      "!ref": XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 39_999, c: 9 } }),
      A1: { t: "s", v: "s1" },
    };
    const ws2: XLSX.WorkSheet = {
      "!ref": XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 29_999, c: 9 } }),
      A1: { t: "s", v: "s2" },
    };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, "Sheet1");
    XLSX.utils.book_append_sheet(wb, ws2, "Sheet2");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

    const parsed = parseSpreadsheet(buf, { ext: "xlsx" });
    expect(parsed[0]?.rows).toBe(40_000);
    expect(parsed[0]?.cols).toBe(10);
    expect(parsed[0]?.totalRows).toBeUndefined();
    expect(parsed[0]?.truncated).toBeUndefined();

    expect(parsed[1]?.rows).toBe(10_000);
    expect(parsed[1]?.cols).toBe(10);
    expect(parsed[1]?.totalRows).toBe(30_000);
    expect(parsed[1]?.truncated).toBe(true);
  });

  // Mutation caught: unbounded column allocation without MAX_GRID_COLS / keptCols cap
  it("caps forged wide dimension sheet to 16,384 cols with totalCols and truncated", () => {
    // Codex's reproduction: a few-KB file whose <dimension> declares 500 002 columns.
    const ref = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: 500_001 } });
    const parsed = parseSpreadsheet(forgedDimensionWorkbook(ref), { ext: "xlsx" });
    expect(parsed[0]?.cols).toBe(16_384);
    expect(parsed[0]?.colWidths.length).toBe(16_384);
    expect(parsed[0]?.cells[0]?.length).toBe(16_384);
    expect(parsed[0]?.totalCols).toBe(500_002);
    expect(parsed[0]?.truncated).toBe(true);
  });

  // Mutation caught: empty or budget-exhausted sheet keeping cols > 0 when keptRows is 0
  it("reports cols 0 and colWidths length 0 for sheet with 0 kept rows", () => {
    const wsFull: XLSX.WorkSheet = {
      "!ref": XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 49_999, c: 9 } }),
      A1: { t: "s", v: "full" },
    };
    const wsZero: XLSX.WorkSheet = {
      "!ref": XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 9, c: 9 } }),
      A1: { t: "s", v: "zero" },
    };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsFull, "Full");
    XLSX.utils.book_append_sheet(wb, wsZero, "Zero");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

    const parsed = parseSpreadsheet(buf, { ext: "xlsx" });
    expect(parsed[1]?.rows).toBe(0);
    expect(parsed[1]?.cols).toBe(0);
    expect(parsed[1]?.colWidths.length).toBe(0);
  });

  // Mutation caught: countLines counting LF characters in quoted multiline CSV cells
  it("parses CSV with multiline cell as 2 rows without truncated or totalRows", () => {
    const csv = 'a,b\n"one\ntwo",c\n';
    const buf = new TextEncoder().encode(csv);

    const parsed = parseSpreadsheet(buf, { ext: "csv" });
    expect(parsed[0]?.rows).toBe(2);
    expect(parsed[0]?.truncated).toBeUndefined();
    expect(parsed[0]?.totalRows).toBeUndefined();
  });

  // Mutation caught: countLines failing to detect CR-separated records truncation
  it("truncates 100,001 CR-separated CSV records to 100,000 rows with unknown totalRows", () => {
    const records = Array.from({ length: 100_001 }, (_, i) => `rec${i}`).join("\r");
    const buf = new TextEncoder().encode(records);

    const parsed = parseSpreadsheet(buf, { ext: "csv" });
    expect(parsed[0]?.rows).toBe(100_000);
    expect(parsed[0]?.truncated).toBe(true);
    expect(parsed[0]?.totalRows).toBeUndefined();
  });

  it("parses 100 001-record by 16 385-column CSV with rowsTruncated and totalCols set", () => {
    // Catches mutation: failing to set rowsTruncated when rows are dropped in a CSV
    const header = ",".repeat(16384) + "\n";
    const body = "\n".repeat(100000);
    const data = new TextEncoder().encode(header + body);
    const sheets = parseSpreadsheet(data, { ext: "csv" });
    const sheet = sheets[0];
    expect(sheet?.rowsTruncated).toBe(true);
    expect(sheet?.totalCols).toBe(16385);
  });
});
