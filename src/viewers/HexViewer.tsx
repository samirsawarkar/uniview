import { useEffect, useState } from "react";
import { formatBytes } from "../core/errors";
import { hexRows } from "../core/hex";
import { Spacer, Toolbar, useLoad, useReady } from "./common";
import type { ViewerProps } from "./types";

const PAGE = 64 * 1024;

export default function HexViewer({ source, detection, onReady }: ViewerProps & { note?: string }) {
  const [page, setPage] = useState(0);
  const pages = source.size > 0 ? Math.ceil(source.size / PAGE) : 1;
  const rows = useLoad(async (signal) => hexRows(new Uint8Array(await source.readRange(page * PAGE, page * PAGE + PAGE, signal)), page * PAGE), [source, page]);
  useEffect(() => setPage(0), [source]);
  useReady(!!rows, onReady);
  return (
    <div className="viewer hex-viewer">
      <Toolbar>
        <span className="muted small">{detection.label} · {formatBytes(source.size)}</span>
        <Spacer />
        {pages > 1 && (
          <>
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>‹</button>
            <span className="muted small">Offset {(page * PAGE).toString(16)} · page {page + 1} of {pages}</span>
            <button onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}>›</button>
          </>
        )}
      </Toolbar>
      <div className="scroll">
        <pre className="hex" data-testid="hex">{rows ? rows.join("\n") : "Reading…"}</pre>
      </div>
    </div>
  );
}
