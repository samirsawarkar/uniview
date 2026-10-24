import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { parseSpreadsheet } from "../../src/viewers/sheet-parse";

// Generating and parsing 10^5-row workbooks takes several seconds.
describe("sheet-large parsing and budget truncation", { timeout: 60_000 }, () => {
  it("truncates 120 000 rows × 10 columns sheet to 50 000 rows within 500 000 slot budget", () => {
    // Catches: the old budget error (exceeds maximum grid slot budget), or allocating all rows instead of slot budget limit
    const numRows = 120_000;
    const numCols = 10;
    const data: (string | number)[][] = new Array(numRows);
    for (let r = 0; r < numRows; r++) {
      const row: (string | number)[] = new Array(numCols);
      row[0] = `row-${r + 1}`;
      for (let c = 1; c < numCols; c++) {
        row[c] = c;
      }
      data[r] = row;
    }

    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

    const result = parseSpreadsheet(buf);
    expect(result.length).toBe(1);
    const sheet = result[0]!;
    expect(sheet.rows).toBe(50_000);
    expect(sheet.totalRows).toBe(120_000);
    expect(sheet.cells.length).toBe(50_000);
    expect(sheet.cells[49_999]?.[0]).toBe("row-50000");
  });

  it("does not truncate 60 000 rows × 5 columns sheet that fits within slot budget", () => {
    // Catches: premature truncation or setting totalRows on sheets that fit within slot budget and parse cap
    const numRows = 60_000;
    const numCols = 5;
    const data: (string | number)[][] = new Array(numRows);
    for (let r = 0; r < numRows; r++) {
      const row: (string | number)[] = new Array(numCols);
      row[0] = `r${r + 1}`;
      for (let c = 1; c < numCols; c++) {
        row[c] = c;
      }
      data[r] = row;
    }

    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

    const result = parseSpreadsheet(buf);
    expect(result.length).toBe(1);
    const sheet = result[0]!;
    expect(sheet.rows).toBe(60_000);
    expect(sheet.totalRows).toBeUndefined();
    expect("totalRows" in sheet).toBe(false);
  });

  it("caps 150 000 rows × 2 columns sheet at MAX_PARSE_ROWS (100 000 rows)", () => {
    // Catches: missing MAX_PARSE_ROWS cap or failure to record totalRows from !fullref
    const numRows = 150_000;
    const numCols = 2;
    const data: (string | number)[][] = new Array(numRows);
    for (let r = 0; r < numRows; r++) {
      data[r] = [`r${r + 1}`, 1];
    }

    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

    const result = parseSpreadsheet(buf);
    expect(result.length).toBe(1);
    const sheet = result[0]!;
    expect(sheet.rows).toBe(100_000);
    expect(sheet.totalRows).toBe(150_000);
  });

  it("walks multi-sheet workbook, keeping first sheet full and truncating second sheet", () => {
    // Catches: failing to deduct slots from remaining budget across multiple sheets
    const data1: (string | number)[][] = new Array(40_000);
    for (let r = 0; r < 40_000; r++) {
      const row: (string | number)[] = new Array(10);
      row[0] = `s1-r${r + 1}`;
      for (let c = 1; c < 10; c++) row[c] = c;
      data1[r] = row;
    }

    const data2: (string | number)[][] = new Array(30_000);
    for (let r = 0; r < 30_000; r++) {
      const row: (string | number)[] = new Array(10);
      row[0] = `s2-r${r + 1}`;
      for (let c = 1; c < 10; c++) row[c] = c;
      data2[r] = row;
    }

    const ws1 = XLSX.utils.aoa_to_sheet(data1);
    const ws2 = XLSX.utils.aoa_to_sheet(data2);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, "Sheet1");
    XLSX.utils.book_append_sheet(wb, ws2, "Sheet2");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

    const result = parseSpreadsheet(buf);
    expect(result.length).toBe(2);
    const sheet1 = result[0]!;
    const sheet2 = result[1]!;
    expect(sheet1.rows).toBe(40_000);
    expect(sheet1.totalRows).toBeUndefined();
    expect(sheet2.rows).toBe(10_000);
    expect(sheet2.totalRows).toBe(30_000);
  });

  it("truncates CSV with 120 000 lines to 100 000 rows with totalRows 120 000", () => {
    // Catches: failing to pass sheetRows to CSV reader or failing to record totalRows from !fullref on CSV
    const lines: string[] = new Array(120_000);
    for (let i = 0; i < 120_000; i++) {
      lines[i] = `a${i + 1},b${i + 1},c${i + 1}`;
    }
    const csvText = lines.join("\n");
    const buf = new TextEncoder().encode(csvText);

    const result = parseSpreadsheet(buf, { ext: "csv" });
    expect(result.length).toBe(1);
    const sheet = result[0]!;
    expect(sheet.rows).toBe(100_000);
    expect(sheet.totalRows).toBe(120_000);
  });
});
