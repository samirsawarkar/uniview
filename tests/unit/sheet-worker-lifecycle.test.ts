import { describe, it, expect, vi, afterEach } from "vitest";
import { parseWorkbook } from "../../src/viewers/SheetViewer";
import { parseSpreadsheet, type ParsedSheet } from "../../src/viewers/sheet-parse";
import type { Detection } from "../../src/core/types";

vi.mock("../../src/viewers/sheet-parse", () => ({
  DEFAULT_COL_W: 110,
  parseSpreadsheet: vi.fn(() => []),
}));

describe("sheet worker lifecycle", () => {
  const detection: Detection = {
    kind: "sheet",
    label: "Spreadsheet",
    ext: "xlsx",
    by: "extension",
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("noWorker alreadyaborted rejects AbortError/parsernotcalled", async () => {
    vi.stubGlobal("Worker", undefined);
    const controller = new AbortController();
    controller.abort();
    const buf = new ArrayBuffer(0);

    const promise = parseWorkbook(buf, detection, controller.signal);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(parseSpreadsheet).not.toHaveBeenCalled();
  });

  it("constructorabortsthenthrows rejects no parser", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "Worker",
      class MockWorker {
        constructor() {
          controller.abort();
          throw new Error("Worker constructor failed");
        }
      },
    );
    const buf = new ArrayBuffer(0);

    const promise = parseWorkbook(buf, detection, controller.signal);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(parseSpreadsheet).not.toHaveBeenCalled();
  });

  it("successful fallback resolves", async () => {
    vi.stubGlobal(
      "Worker",
      class MockWorker {
        constructor() {
          throw new Error("Worker constructor failed");
        }
      },
    );
    const mockSheets: ParsedSheet[] = [
      {
        name: "Sheet1",
        rows: 1,
        cols: 1,
        cells: [["A1"]],
        colWidths: [110],
        merges: [],
      },
    ];
    vi.mocked(parseSpreadsheet).mockReturnValue(mockSheets);
    const controller = new AbortController();
    const buf = new ArrayBuffer(0);

    const result = await parseWorkbook(buf, detection, controller.signal);
    expect(result).toEqual(mockSheets);
    expect(parseSpreadsheet).toHaveBeenCalledWith(buf, detection);
  });

  it("pendingworkerabort terminates", async () => {
    const terminate = vi.fn();
    const postMessage = vi.fn();

    vi.stubGlobal(
      "Worker",
      class MockWorker {
        terminate = terminate;
        postMessage = postMessage;
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: ((e: any) => void) | null = null;
      },
    );

    const controller = new AbortController();
    const buf = new ArrayBuffer(0);

    const promise = parseWorkbook(buf, detection, controller.signal);
    expect(postMessage).toHaveBeenCalled();

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(terminate).toHaveBeenCalled();
  });

  it("successfulworkermessage terminates/resolves", async () => {
    const terminate = vi.fn();
    const postMessage = vi.fn();
    let instance: any;

    vi.stubGlobal(
      "Worker",
      class MockWorker {
        terminate = terminate;
        postMessage = postMessage;
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: ((e: any) => void) | null = null;
        constructor() {
          instance = this;
        }
      },
    );

    const controller = new AbortController();
    const buf = new ArrayBuffer(0);
    const mockSheets: ParsedSheet[] = [
      {
        name: "Sheet1",
        rows: 1,
        cols: 1,
        cells: [["A1"]],
        colWidths: [110],
        merges: [],
      },
    ];

    const promise = parseWorkbook(buf, detection, controller.signal);
    expect(postMessage).toHaveBeenCalled();

    instance.onmessage?.({
      data: {
        ok: true,
        sheets: mockSheets,
      },
    } as MessageEvent);

    const result = await promise;
    expect(result).toEqual(mockSheets);
    expect(terminate).toHaveBeenCalled();
  });
});
