import { useMemo, useState } from "react";
import { formatBytes } from "../core/errors";
import { listZip, readZipEntries, type ZipEntry } from "../core/zip";
import { memorySource } from "../shells/sources";
import { Loading, Spacer, Toolbar, readAllChecked, useLoad, useReady } from "./common";
import type { ViewerProps } from "./types";

export default function ZipViewer({ source, onReady, onOpen }: ViewerProps) {
  const data = useLoad(async (signal) => {
    const buf = new Uint8Array(await readAllChecked(source, signal));
    return { buf, entries: listZip(buf) };
  }, [source]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  useReady(!!data, onReady);
  const shown = useMemo(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    return data.entries.filter((e) => !e.isDirectory && (!q || e.name.toLowerCase().includes(q)));
  }, [data, filter]);
  if (!data) return <Loading label="Reading archive…" />;
  const total = data.entries.reduce((n, e) => n + e.size, 0);

  const open = (entry: ZipEntry) => {
    try {
      const bytes = readZipEntries(data.buf, (n) => n === entry.name).get(entry.name);
      if (!bytes) throw new Error("entry not found");
      onOpen([memorySource(bytes, entry.name.split("/").pop() || entry.name)]);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="viewer zip-viewer">
      <Toolbar>
        <input type="search" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter files" />
        <Spacer />
        <span className="muted small">{data.entries.filter((e) => !e.isDirectory).length} files · {formatBytes(total)} uncompressed</span>
      </Toolbar>
      {error && <div className="banner warn">{error}</div>}
      <div className="scroll">
        <table className="file-table" data-testid="zip-table">
          <thead><tr><th>Name</th><th className="num">Size</th><th className="num">Packed</th></tr></thead>
          <tbody>
            {shown.slice(0, 5000).map((e) => (
              <tr key={e.name} onDoubleClick={() => open(e)} onKeyDown={(k) => k.key === "Enter" && open(e)} tabIndex={0}>
                <td><button className="link" onClick={() => open(e)} title="Open in a new tab">{e.name}</button></td>
                <td className="num">{formatBytes(e.size)}</td>
                <td className="num muted">{formatBytes(e.compressedSize)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length > 5000 && <div className="muted small pad">Showing the first 5,000 of {shown.length.toLocaleString()} files. Use the filter to narrow down.</div>}
      </div>
    </div>
  );
}
