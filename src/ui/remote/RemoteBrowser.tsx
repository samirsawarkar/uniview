import { useCallback, useEffect, useRef, useState } from "react";
import type { HostRecord, RemoteEntry, RemoteHost } from "../../../shared/remote-client.mjs";
import type { FileSource, RemoteTransport } from "../../core/types";
import { formatBytes } from "../../core/errors";
import { detect } from "../../core/detect";
import { connect } from "../../remote/connections";
import { remoteSource } from "../../remote/source";
import { cachedThumb, storeThumb } from "../../remote/store";
import { KindBadge } from "../badges";

export interface RemoteLocation {
  root?: { id: string; name: string };
  path: string;
}

/** Browse a paired computer's shared folders and open files on demand. */
export function RemoteBrowser({ record, transport, location, onNavigate, onOpen }: {
  record: HostRecord;
  transport: RemoteTransport;
  location: RemoteLocation;
  onNavigate: (loc: RemoteLocation) => void;
  onOpen: (files: FileSource[]) => void;
}) {
  const [host, setHost] = useState<RemoteHost | null>(null);
  const [roots, setRoots] = useState<{ id: string; name: string }[] | null>(null);
  const [entries, setEntries] = useState<RemoteEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    setEntries(null);
    void (async () => {
      try {
        const h = await connect(record, transport);
        if (!live) return;
        setHost(h);
        if (!location.root) {
          const info = await h.info();
          if (live) setRoots(info.roots);
        } else {
          const list = await h.list(location.root.id, location.path);
          if (live) setEntries(list);
        }
      } catch (err) {
        if (live) setError((err as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [record, transport, location.root, location.path, reload]);

  const crumbs = location.path ? location.path.split("/") : [];
  const q = filter.trim().toLowerCase();
  const shown = entries?.filter((e) => !q || e.name.toLowerCase().includes(q)) ?? [];

  const open = (e: RemoteEntry) => {
    if (!host || !location.root) return;
    const path = [location.path, e.name].filter(Boolean).join("/");
    if (e.dir) return onNavigate({ root: location.root, path });
    onOpen([remoteSource({ host, hostName: record.hostName, root: location.root.id, rootName: location.root.name, path, entry: e })]);
  };

  return (
    <div className="viewer remote-browser" data-testid="remote-browser">
      <div className="toolbar">
        <nav className="crumbs" aria-label="Location">
          <button className="link" onClick={() => onNavigate({ path: "" })}>{record.hostName}</button>
          {location.root && (
            <>
              <span className="muted">/</span>
              <button className="link" onClick={() => onNavigate({ root: location.root, path: "" })}>{location.root.name}</button>
            </>
          )}
          {crumbs.map((c, i) => (
            <span key={i}>
              <span className="muted">/</span>
              <button className="link" onClick={() => onNavigate({ root: location.root, path: crumbs.slice(0, i + 1).join("/") })}>{c}</button>
            </span>
          ))}
        </nav>
        <div className="spacer" />
        {location.root && <input type="search" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter files" />}
        <button onClick={() => setReload((n) => n + 1)} title="Refresh">⟳</button>
      </div>
      {error ? (
        <div className="center-msg" role="alert">
          <strong>Can't reach {record.hostName}</strong>
          <span>{error}</span>
          <button onClick={() => setReload((n) => n + 1)}>Try again</button>
        </div>
      ) : !location.root ? (
        roots === null ? (
          <div className="center-msg">Connecting securely to {record.hostName}…</div>
        ) : roots.length === 0 ? (
          <div className="center-msg">{record.hostName} isn't sharing any folders yet.</div>
        ) : (
          <div className="scroll"><div className="file-grid">
            {roots.map((r) => (
              <button key={r.id} className="file-tile" onClick={() => onNavigate({ root: r, path: "" })}>
                <span className="tile-art folder" aria-hidden>📁</span>
                <span className="tile-name">{r.name}</span>
              </button>
            ))}
          </div></div>
        )
      ) : entries === null ? (
        <div className="center-msg">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="center-msg">{q ? "No files match." : "This folder is empty."}</div>
      ) : (
        <div className="scroll"><div className="file-grid" data-testid="remote-entries">
          {shown.map((e) => (
            <button key={e.name} className="file-tile" onClick={() => open(e)} title={e.dir ? e.name : `${e.name}\n${formatBytes(e.size)} · ${new Date(e.mtime).toLocaleString()}`}>
              {e.dir ? <span className="tile-art folder" aria-hidden>📁</span> : <Thumb host={host} record={record} root={location.root!.id} path={[location.path, e.name].filter(Boolean).join("/")} entry={e} />}
              <span className="tile-name">{e.name}</span>
              {!e.dir && <span className="tile-meta muted small">{formatBytes(e.size)}</span>}
            </button>
          ))}
        </div></div>
      )}
    </div>
  );
}

const THUMBABLE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|mp4|mov|m4v|mkv|webm|avi|pdf|docx?|xlsx?|pptx?)$/i;

/** OS-generated thumbnail from the host, fetched when visible and cached on this device. */
function Thumb({ host, record, root, path, entry }: { host: RemoteHost | null; record: HostRecord; root: string; path: string; entry: RemoteEntry }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!host || !THUMBABLE.test(entry.name)) return;
    const key = `${record.hostId}|${root}|${path}|${entry.mtime}`;
    let blob = await cachedThumb(key);
    if (!blob) {
      try {
        blob = new Blob([(await host.thumb(root, path, 192)) as BlobPart], { type: "image/png" });
        void storeThumb(key, blob);
      } catch {
        return;
      }
    }
    setUrl(URL.createObjectURL(blob));
  }, [host, record.hostId, root, path, entry]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        io.disconnect();
        void load();
      }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [load]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const kind = detect(entry.name, new Uint8Array(0)).kind;
  return (
    <span className="tile-art" ref={ref}>
      {url ? <img src={url} alt="" draggable={false} /> : <KindBadge kind={kind} />}
    </span>
  );
}
