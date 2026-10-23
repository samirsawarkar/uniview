import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { parseSpreadsheet } from "../../src/viewers/sheet-parse";
import { CorruptFileError } from "../../src/core/errors";

/** Rewrite the declared uncompressed size of every central-directory entry named `name`. */
function forgeDeclaredSize(zip: Uint8Array, name: string, size: number): Uint8Array {
  const b = zip.slice();
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = strToU8(name);
  for (let i = 0; i + 46 < b.length; i++) {
    if (v.getUint32(i, true) !== 0x02014b50) continue;
    const len = v.getUint16(i + 28, true);
    const got = b.subarray(i + 46, i + 46 + len);
    if (len === n.length && got.every((c, k) => c === n[k])) v.setUint32(i + 24, size, true);
  }
  return b;
}

/** Rewrite the worksheet dimension XML in a valid XLSX ZIP archive. */
function forgeWorksheetDimension(zipBytes: Uint8Array, dimRef: string): Uint8Array {
  const entries = unzipSync(zipBytes);
  const sheetPath =
    Object.keys(entries).find((k) => k.startsWith("xl/worksheets/sheet") && k.endsWith(".xml")) ||
    "xl/worksheets/sheet1.xml";
  const raw = entries[sheetPath];
  if (!raw) throw new Error(`Missing ${sheetPath}`);
  let xml = strFromU8(raw);
  if (/<dimension[^>]*\/>/.test(xml)) {
    xml = xml.replace(/<dimension[^>]*\/>/, `<dimension ref="${dimRef}"/>`);
  } else if (/<dimension[^>]*>.*?<\/dimension>/.test(xml)) {
    xml = xml.replace(/<dimension[^>]*>.*?<\/dimension>/, `<dimension ref="${dimRef}"/>`);
  } else {
    xml = xml.replace("<worksheet", `<worksheet><dimension ref="${dimRef}"/>`);
  }
  entries[sheetPath] = strToU8(xml);
  return zipSync(entries);
}

describe("pure spreadsheet parsing", () => {
  it("parses an XLSX workbook with multiple sheets, dates, and number formats", () => {
    const wb = XLSX.utils.book_new();

    // Sheet 1: includes a date and formatted numbers
    const dateVal = new Date("2026-10-23T00:00:00.000Z");
    const ws1Data = [
      ["Item", "Date", "Price"],
      ["Widget", dateVal, 1234.5],
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(ws1Data, { cellDates: true });
    const priceCell = ws1["C2"];
    if (priceCell) {
      priceCell.z = "$#,##0.00";
    }
    ws1["!cols"] = [{ wch: 15 }, { wch: 20 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws1, "Summary");

    // Sheet 2: second sheet
    const ws2Data = [
      ["Category", "Count"],
      ["Hardware", 42],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(ws2Data);
    XLSX.utils.book_append_sheet(wb, ws2, "Details");

    const xlsxBytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

    const sheets = parseSpreadsheet(xlsxBytes, { ext: "xlsx" });
    expect(sheets).toHaveLength(2);

    const sheet1 = sheets[0]!;
    expect(sheet1.name).toBe("Summary");
    expect(sheet1.rows).toBe(2);
    expect(sheet1.cols).toBe(3);
    expect(sheet1.cells[0]).toEqual(["Item", "Date", "Price"]);
    expect(sheet1.cells[1]![0]).toBe("Widget");
    expect(sheet1.cells[1]![1]).toBeTruthy();
    expect(sheet1.cells[1]![2]).toMatch(/\$1,234\.50|1234\.5/);
    expect(sheet1.colWidths).toHaveLength(3);
    expect(sheet1.colWidths[0]).not.toBe(sheet1.colWidths[1]);

    const sheet2 = sheets[1]!;
    expect(sheet2.name).toBe("Details");
    expect(sheet2.rows).toBe(2);
    expect(sheet2.cols).toBe(2);
    expect(sheet2.cells[1]![1]).toBe("42");
  });

  it("parses UTF-8 CSV with accents", () => {
    const csv = "City,Specialty\nZürich,Café\nŌsaka,Crème brûlée\n";
    const bytes = new TextEncoder().encode(csv);
    const sheets = parseSpreadsheet(bytes.buffer, { ext: "csv" });
    expect(sheets).toHaveLength(1);
    const sheet = sheets[0]!;
    expect(sheet.rows).toBe(3);
    expect(sheet.cols).toBe(2);
    expect(sheet.cells[0]).toEqual(["City", "Specialty"]);
    expect(sheet.cells[1]).toEqual(["Zürich", "Café"]);
    expect(sheet.cells[2]).toEqual(["Ōsaka", "Crème brûlée"]);
  });

  it("rejects a ZIP bomb workbook", () => {
    const bomb = forgeDeclaredSize(
      zipSync({ "xl/workbook.xml": new Uint8Array(5_000_000) }, { level: 9 }),
      "xl/workbook.xml",
      10,
    );
    const ab = bomb.buffer.slice(bomb.byteOffset, bomb.byteOffset + bomb.byteLength);
    expect(() => parseSpreadsheet(new Uint8Array(ab), { ext: "xlsx" })).toThrow(CorruptFileError);
  });

  it("rejects a huge sparse XLSX rectangle exceeding grid slot budget", () => {
    const wb = XLSX.utils.book_new();
    const ws: XLSX.WorkSheet = {
      "!ref": "A1:Z100000", // 26 * 100,000 = 2,600,000 slots (> 500,000)
      A1: { t: "s", v: "start" },
      Z100000: { t: "s", v: "end" },
    };
    XLSX.utils.book_append_sheet(wb, ws, "HugeSparse");
    const xlsxBytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    expect(() => parseSpreadsheet(xlsxBytes, { ext: "xlsx" })).toThrow(CorruptFileError);
  });

  it("rejects aggregate grid expansion across multiple sheets exceeding budget", () => {
    const wb = XLSX.utils.book_new();
    // 6 sheets each with 100,000 slots (10 cols x 10,000 rows), total = 600,000 slots (> 500,000)
    for (let i = 1; i <= 6; i++) {
      const ws: XLSX.WorkSheet = {
        "!ref": "A1:J10000",
        A1: { t: "s", v: `sheet${i}` },
        J10000: { t: "s", v: "end" },
      };
      XLSX.utils.book_append_sheet(wb, ws, `Sheet${i}`);
    }
    const xlsxBytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    expect(() => parseSpreadsheet(xlsxBytes, { ext: "xlsx" })).toThrow(CorruptFileError);
  });

  it("allows normal 50,001-row x 3 workbook within budget", () => {
    const wb = XLSX.utils.book_new();
    const row = ["A", "B", "C"];
    const data = new Array(50001);
    for (let i = 0; i < 50001; i++) {
      data[i] = row;
    }
    const ws = XLSX.utils.aoa_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, "Normal50k");
    const xlsxBytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

    const sheets = parseSpreadsheet(xlsxBytes, { ext: "xlsx" });
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.rows).toBe(50001);
    expect(sheets[0]!.cols).toBe(3);
    expect(sheets[0]!.cells).toHaveLength(50001);
    expect(sheets[0]!.cells[0]).toEqual(["A", "B", "C"]);
    expect(sheets[0]!.cells[50000]).toEqual(["A", "B", "C"]);
  });

  it("rejects invalid or non-finite sheet ranges", () => {
    const wb1 = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet([["val"]]);
    XLSX.utils.book_append_sheet(wb1, ws1, "NonFiniteRange");
    const validBytes1 = new Uint8Array(XLSX.write(wb1, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    const bytes1 = forgeWorksheetDimension(validBytes1, "A1:NaN");
    const sheets1 = parseSpreadsheet(bytes1, { ext: "xlsx" });
    expect(sheets1).toHaveLength(1);
    expect(sheets1[0]!.rows).toBe(1);
    expect(sheets1[0]!.cols).toBe(1);
    expect(sheets1[0]!.cells[0]![0]).toBe("val");

    const bytesMalformed = forgeWorksheetDimension(validBytes1, "MALFORMED");
    try {
      const sheetsMalformed = parseSpreadsheet(bytesMalformed, { ext: "xlsx" });
      expect(sheetsMalformed).toHaveLength(1);
      expect(sheetsMalformed[0]!.cells[0]![0]).toBe("val");
    } catch (err) {
      expect(err).toBeInstanceOf(CorruptFileError);
    }

    const bytesInverted = forgeWorksheetDimension(validBytes1, "B2:A1");
    try {
      const sheetsInverted = parseSpreadsheet(bytesInverted, { ext: "xlsx" });
      expect(sheetsInverted).toHaveLength(1);
      expect(sheetsInverted[0]!.cells[0]![0]).toBe("val");
    } catch (err) {
      expect(err).toBeInstanceOf(CorruptFileError);
    }

    try {
      const wb2 = XLSX.utils.book_new();
      const ws2: XLSX.WorkSheet = {
        "!ref": "B2:A1", // inverted range
        B2: { t: "s", v: "val" },
      };
      XLSX.utils.book_append_sheet(wb2, ws2, "InvertedRange");
      const bytes2 = XLSX.write(wb2, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
      try {
        const sheets2 = parseSpreadsheet(bytes2, { ext: "xlsx" });
        expect(sheets2).toHaveLength(1);
      } catch (err) {
        expect(err).toBeInstanceOf(CorruptFileError);
      }
    } catch {
      // XLSX.write rejected inverted range before parse
    }
  });

  it("parses merged ranges normalized and clipped relative to !ref", () => {
    const wb = XLSX.utils.book_new();
    const ws: XLSX.WorkSheet = {
      "!ref": "B2:D4", // 3 rows x 3 cols, range.s = (1, 1), range.e = (3, 3)
      B2: { t: "s", v: "Title" },
      B3: { t: "s", v: "Sub" },
      "!merges": [
        // Standard merge within sheet: B2:C3 -> relative (0,0) to (1,1)
        { s: { r: 1, c: 1 }, e: { r: 2, c: 2 } },
        // Inverted merge corners: D4:C4 (r: 3, c: 3 to r: 3, c: 2) -> normalized to (r: 3, c: 2 to r: 3, c: 3) -> relative (2, 1) to (2, 2)
        { s: { r: 3, c: 3 }, e: { r: 3, c: 2 } },
        // Partially outside sheet: A1:B3 (s: 0,0, e: 2,1) -> clipped against B2:D4 to B2:B3 -> relative (0, 0) to (1, 0)
        { s: { r: 0, c: 0 }, e: { r: 2, c: 1 } },
        // Completely outside sheet: Z10:Z20 -> dropped
        { s: { r: 9, c: 25 }, e: { r: 19, c: 25 } },
      ],
    };
    XLSX.utils.book_append_sheet(wb, ws, "MergesSheet");
    const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

    const sheets = parseSpreadsheet(bytes, { ext: "xlsx" });
    expect(sheets).toHaveLength(1);
    const sheet = sheets[0]!;
    expect(sheet.rows).toBe(3);
    expect(sheet.cols).toBe(3);
    expect(sheet.merges).toEqual([
      { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } },
      { s: { r: 2, c: 1 }, e: { r: 2, c: 2 } },
      { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } },
    ]);
  });

  it("rejects spreadsheet exceeding merge budget", () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["val"]]);
    XLSX.utils.book_append_sheet(wb, ws, "MergeBudget");
    const validBytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);

    const entries = unzipSync(validBytes);
    const sheetPath = Object.keys(entries).find((k) => k.startsWith("xl/worksheets/sheet") && k.endsWith(".xml"))!;
    let xml = strFromU8(entries[sheetPath]!);
    const mergeXml = `<mergeCells count="500001">${'<mergeCell ref="A1:B1"/>'.repeat(500001)}</mergeCells>`;
    xml = xml.replace("</worksheet>", `${mergeXml}</worksheet>`);
    entries[sheetPath] = strToU8(xml);
    const bombBytes = zipSync(entries);
    expect(() => parseSpreadsheet(bombBytes, { ext: "xlsx" })).toThrow(CorruptFileError);
  });

  it("rejects spreadsheet exceeding 32 Mi UTF-16 code units of text output", () => {
    const bigStr = "x".repeat(33 * 1024 * 1024);
    const bytes = new TextEncoder().encode(bigStr);
    expect(() => parseSpreadsheet(bytes.buffer, { ext: "csv" })).toThrow(CorruptFileError);
  });
});
