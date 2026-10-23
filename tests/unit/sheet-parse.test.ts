import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { zipSync, strToU8 } from "fflate";
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
});
