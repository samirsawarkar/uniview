import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { CorruptFileError } from "../core/errors";
import { decodeText } from "../core/zip";
import { Loading, Spacer, Toolbar, readAllChecked, useLoad, useReady } from "./common";
import type { ViewerProps } from "./types";

const ROW_H = 24;
const HEADER_H = 24;
const ROWNUM_W = 56;
const DEFAULT_COL_W = 110;

interface Grid {
  name: string;
  rows: number;
  cols: number;
  cell(r: number, c: number): string;
  colWidth(c: number): number;
}

function toGrid(ws: XLSX.WorkSheet, name: string): Grid {
  const ref = ws["!ref"];
  const range = ref ? XLSX.utils.decode_range(ref) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
  const dense = (ws as unknown as { "!data"?: (XLSX.CellObject | undefined)[][] })["!data"];
  const widths = (ws["!cols"] ?? []).map((c) => (c?.wpx ? c.wpx : c?.wch ? c.wch * 7 + 10 : undefined));
  return {
    name,
    rows: range.e.r - range.s.r + 1,
    cols: range.e.c - range.s.c + 1,
    cell(r, c) {
      const rr = r + range.s.r, cc = c + range.s.c;
      const cell = dense ? dense[rr]?.[cc] : ws[XLSX.utils.encode_cell({ r: rr, c: cc })];
      if (!cell) return "";
      if (cell.w !== undefined) return cell.w;
      if (cell.v === undefined || cell.v === null) return "";
      return cell.v instanceof Date ? cell.v.toLocaleString() : String(cell.v);
    },
    colWidth: (c) => Math.max(40, Math.min(480, widths[c + range.s.c] ?? DEFAULT_COL_W)),
  };
}

export default function SheetViewer({ source, detection, onReady }: ViewerProps) {
  const book = useLoad(async (signal) => {
    const buf = await readAllChecked(source, signal, 256 * 1024 * 1024);
    try {
      const isText = detection.ext === "csv" || detection.ext === "tsv" || detection.by === "content";
      // SheetJS reads raw bytes as Latin-1 unless there is a BOM; decode UTF-8 first so accents survive.
      const wb = isText
        ? XLSX.read(decodeText(new Uint8Array(buf)), { type: "string", dense: true, cellDates: true, raw: false, FS: detection.ext === "tsv" ? "\t" : undefined })
        : XLSX.read(buf, { type: "array", dense: true, cellDates: true, cellStyles: false, sheetStubs: false });
      return wb;
    } catch (err) {
      throw new CorruptFileError(`This spreadsheet could not be read: ${(err as Error).message}`);
    }
  }, [source]);
  const [active, setActive] = useState(0);
  const grids = useMemo(() => (book ? book.SheetNames.map((n) => toGrid(book.Sheets[n]!, n)) : []), [book]);
  useReady(!!book, onReady);
  if (!book) return <Loading label="Reading workbook…" />;
  const grid = grids[Math.min(active, grids.length - 1)];
  return (
    <div className="viewer sheet-viewer">
      <Toolbar>
        <span className="muted small">{grid ? `${grid.rows.toLocaleString()} rows × ${grid.cols.toLocaleString()} columns` : "Empty workbook"}</span>
        <Spacer />
        <span className="muted small">{detection.label}</span>
      </Toolbar>
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
function VirtualGrid({ grid }: { grid: Grid }) {
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
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
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
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
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
    <div className="grid-scroll" ref={ref} onScroll={(e) => setView((v) => ({ ...v, top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft }))} data-testid="sheet-grid">
      <div className="grid-canvas" style={{ width: totalW + ROWNUM_W, height: totalH + HEADER_H }}>
        <div className="grid-cols" style={{ top: view.top, left: ROWNUM_W, width: totalW }}>{colHeads}</div>
        <div className="grid-rows" style={{ left: view.left, top: HEADER_H, height: totalH }}>{rowHeads}</div>
        <div className="grid-corner" style={{ top: view.top, left: view.left }} />
        <div className="grid-cells" style={{ top: HEADER_H, left: ROWNUM_W, width: totalW, height: totalH }}>{cells}</div>
      </div>
    </div>
  );
}
