import { useEffect, useMemo, useRef, useState } from "react";
import type { Detection } from "../core/types";
import { CorruptFileError } from "../core/errors";
import { Loading, Spacer, Toolbar, readAllChecked, useLoad, useReady } from "./common";
import { DEFAULT_COL_W, parseSpreadsheet, type ParsedSheet, type SheetMerge } from "./sheet-parse";
import type { SheetWorkerRequest, SheetWorkerResponse } from "./sheet.worker";
import type { ViewerProps } from "./types";

const ROW_H = 24;
const HEADER_H = 24;
const ROWNUM_W = 56;

export interface Grid {
  name: string;
  rows: number;
  cols: number;
  merges?: SheetMerge[];
  cell(r: number, c: number): string;
  colWidth(c: number): number;
}

export function toGrid(s: ParsedSheet): Grid {
  return {
    name: s.name,
    rows: s.rows,
    cols: s.cols,
    merges: s.merges,
    cell: (r, c) => s.cells[r]?.[c] ?? "",
    colWidth: (c) => s.colWidths[c] ?? DEFAULT_COL_W,
  };
}

/** Shown when the sheet had rows or columns dropped. */
export function SheetTruncatedNotice({ sheet }: { sheet?: ParsedSheet }) {
  if (!sheet || !sheet.truncated) return null;

  let msg = "";
  if (sheet.totalRows !== undefined) {
    msg = `Showing the first ${sheet.rows.toLocaleString()} of ${sheet.totalRows.toLocaleString()} rows.`;
  } else if (sheet.totalCols === undefined) {
    msg = `Showing the first ${sheet.rows.toLocaleString()} rows. The rest of the file is not shown.`;
  }

  if (sheet.totalCols !== undefined) {
    const colMsg = `Showing the first ${sheet.cols.toLocaleString()} of ${sheet.totalCols.toLocaleString()} columns.`;
    msg = msg ? `${msg} ${colMsg}` : colMsg;
  }

  return (
    <p className="sheet-truncated" role="status">
      {msg}
    </p>
  );
}

export function parseWorkbook(
  buf: ArrayBuffer,
  detection: Detection,
  signal: AbortSignal,
): Promise<ParsedSheet[]> {
  if (typeof Worker === "undefined") {
    return Promise.resolve().then(() => {
      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return parseSpreadsheet(buf, detection);
    });
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./sheet.worker.ts", import.meta.url), { type: "module" });
  } catch {
    if (signal.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    try {
      return Promise.resolve(parseSpreadsheet(buf, detection));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  return new Promise<ParsedSheet[]>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      settled = true;
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
    };

    const onAbort = () => {
      if (settled) return;
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    if (signal.aborted) {
      worker.terminate();
      return reject(new DOMException("Aborted", "AbortError"));
    }

    signal.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (e: MessageEvent<SheetWorkerResponse>) => {
      if (settled) return;
      const data = e.data;
      cleanup();
      if (data.ok) {
        resolve(data.sheets);
      } else {
        reject(new CorruptFileError(data.error));
      }
    };

    worker.onerror = (e) => {
      if (settled) return;
      cleanup();
      reject(new CorruptFileError(e.message || "Failed to parse spreadsheet in worker"));
    };

    const req: SheetWorkerRequest = {
      id: 1,
      buffer: buf,
      options: { ext: detection.ext, by: detection.by },
    };
    worker.postMessage(req, [buf]);
  });
}

export default function SheetViewer({ source, detection, onReady }: ViewerProps) {
  const sheets = useLoad(async (signal) => {
    const buf = await readAllChecked(source, signal, 256 * 1024 * 1024);
    return parseWorkbook(buf, detection, signal);
  }, [source]);
  const [active, setActive] = useState(0);
  const grids = useMemo(() => (sheets ? sheets.map(toGrid) : []), [sheets]);
  useReady(!!sheets, onReady);
  if (!sheets) return <Loading label="Reading workbook…" />;
  const activeSheet = sheets[Math.min(active, sheets.length - 1)];
  const grid = grids[Math.min(active, grids.length - 1)];
  return (
    <div className="viewer sheet-viewer">
      <Toolbar>
        <span className="muted small">{grid ? `${grid.rows.toLocaleString()} rows × ${grid.cols.toLocaleString()} columns` : "Empty workbook"}</span>
        <Spacer />
        <span className="muted small">{detection.label}</span>
      </Toolbar>
      <SheetTruncatedNotice sheet={activeSheet} />
      {grid && grid.rows > 0 ? <VirtualGrid key={active} grid={grid} /> : <div className="center-msg">This sheet is empty.</div>}
      {grids.length > 1 && (
        <div className="sheet-tabs" role="tablist">
          {grids.map((g, i) => (
            <button key={g.name} role="tab" aria-selected={i === active} className={i === active ? "active" : ""} onClick={() => setActive(i)}>{g.name}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function colName(c: number): string {
  let s = "";
  c++;
  while (c > 0) {
    const m = (c - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s;
}

/** Renders only the visible window of cells, so million-row sheets scroll smoothly. */
export function VirtualGrid({ grid }: { grid: Grid }) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, left: 0, w: 800, h: 600 });
  const offsets = useMemo(() => {
    const o = new Float64Array(grid.cols + 1);
    for (let c = 0; c < grid.cols; c++) o[c + 1] = o[c]! + grid.colWidth(c);
    return o;
  }, [grid]);
  const totalW = offsets[grid.cols]!;
  const totalH = grid.rows * ROW_H;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setView({ top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth, h: el.clientHeight });
    update();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }
  }, []);

  const r0 = Math.max(0, Math.floor(view.top / ROW_H) - 5);
  const r1 = Math.min(grid.rows, Math.ceil((view.top + view.h) / ROW_H) + 5);
  let c0 = 0;
  while (c0 < grid.cols && offsets[c0 + 1]! < view.left) c0++;
  let c1 = c0;
  while (c1 < grid.cols && offsets[c1]! < view.left + view.w) c1++;
  c0 = Math.max(0, c0 - 2);
  c1 = Math.min(grid.cols, c1 + 2);

  const cells = [];
  const merges = grid.merges ?? [];
  const covered = new Set<string>();

  for (let i = 0; i < merges.length; i++) {
    const m = merges[i]!;
    const r0m = Math.min(m.s.r, m.e.r);
    const r1m = Math.max(m.s.r, m.e.r);
    const c0m = Math.min(m.s.c, m.e.c);
    const c1m = Math.max(m.s.c, m.e.c);
    if (r0m < r1 && r1m >= r0 && c0m < c1 && c1m >= c0) {
      const v = grid.cell(r0m, c0m);
      const startX = offsets[c0m] ?? 0;
      const endX = offsets[Math.min(grid.cols, c1m + 1)] ?? totalW;
      const w = endX - startX;
      const h = (r1m - r0m + 1) * ROW_H;
      cells.push(
        <div
          key={`m:${r0m}:${c0m}`}
          className={`cell ${/^-?[\d,.]+%?$/.test(v) ? "num" : ""}`}
          style={{ top: r0m * ROW_H, left: startX, width: w, height: h }}
          title={v && v.length > 30 ? v : undefined}
        >
          {v}
        </div>,
      );

      const rStart = Math.max(r0, r0m);
      const rEnd = Math.min(r1 - 1, r1m);
      const cStart = Math.max(c0, c0m);
      const cEnd = Math.min(c1 - 1, c1m);
      for (let r = rStart; r <= rEnd; r++) {
        for (let c = cStart; c <= cEnd; c++) {
          covered.add(`${r}:${c}`);
        }
      }
    }
  }

  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      if (covered.has(`${r}:${c}`)) continue;
      const v = grid.cell(r, c);
      if (!v) continue;
      cells.push(
        <div key={`${r}:${c}`} className={`cell ${/^-?[\d,.]+%?$/.test(v) ? "num" : ""}`} style={{ top: r * ROW_H, left: offsets[c], width: grid.colWidth(c) }} title={v.length > 30 ? v : undefined}>
          {v}
        </div>,
      );
    }
  }
  const colHeads = [];
  for (let c = c0; c < c1; c++) colHeads.push(<div key={c} className="col-head" style={{ left: offsets[c], width: grid.colWidth(c) }}>{colName(c)}</div>);
  const rowHeads = [];
  for (let r = r0; r < r1; r++) rowHeads.push(<div key={r} className="row-head" style={{ top: r * ROW_H }}>{r + 1}</div>);

  return (
    <div
      className="grid-scroll"
      ref={ref}
      onScroll={(e) => {
        const { scrollTop, scrollLeft } = e.currentTarget;
        setView((v) => ({ ...v, top: scrollTop, left: scrollLeft }));
      }}
      data-testid="sheet-grid"
    >
      <div className="grid-canvas" style={{ width: totalW + ROWNUM_W, height: totalH + HEADER_H }}>
        <div className="grid-cols" style={{ top: view.top, left: ROWNUM_W, width: totalW }}>{colHeads}</div>
        <div className="grid-rows" style={{ left: view.left, top: HEADER_H, height: totalH }}>{rowHeads}</div>
        <div className="grid-corner" style={{ top: view.top, left: view.left }} />
        <div className="grid-cells" style={{ top: HEADER_H, left: ROWNUM_W, width: totalW, height: totalH }}>{cells}</div>
      </div>
    </div>
  );
}
