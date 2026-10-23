import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Detection, FileSource, FormatKind } from "../core/types";
import { blobSource } from "../shells/sources";
import { getBridge } from "../shells";
import { formatBytes } from "../core/errors";
import { TabView } from "./TabView";
import { badgeFor, KindBadge } from "./badges";
import { loadRecents, rememberRecent, forgetRecent, type Recent } from "./recents";
import { SharingPanel } from "./remote/SharingPanel";
import { PairDialog } from "./remote/PairDialog";
import { RemoteBrowser, type RemoteLocation } from "./remote/RemoteBrowser";
import { forgetHost, loadHosts } from "../remote/store";
import { disconnect } from "../remote/connections";
import { reopenRemoteRecent } from "../remote/reopen-recent";
import type { HostRecord } from "../../shared/remote-client.mjs";

type Page = { kind: "sharing" } | { kind: "remote"; hostId: string; location: RemoteLocation };

interface Tab {
  id: string;
  source: FileSource | null; // null = home tab (or a page)
  detection?: Detection;
  page?: Page;
}

const homeTab = (): Tab => ({ id: `home-${Math.random().toString(36).slice(2)}`, source: null });

declare global {
  interface Window {
    __univiewMetrics?: { name: string; kind?: FormatKind; ms: number }[];
  }
}

export function App() {
  const bridge = useMemo(() => getBridge(), []);
  const [tabs, setTabs] = useState<Tab[]>(() => [homeTab()]);
  const [activeId, setActiveId] = useState(() => tabs[0]!.id);
  const [dragging, setDragging] = useState(false);
  const [recents, setRecents] = useState<Recent[]>(() => loadRecents());
  const [notice, setNotice] = useState<string | null>(null);
  const [hosts, setHosts] = useState<HostRecord[]>(() => loadHosts());
  const [pairing, setPairing] = useState(false);
  const dragDepth = useRef(0);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;

  const openFiles = useCallback((files: FileSource[], replaceHome = true) => {
    if (!files.length) return;
    setTabs((prev) => {
      const next = [...prev];
      const created = files.map((f) => ({ id: f.id, source: f }));
      const idx = next.findIndex((t) => t.id === activeId);
      // Opening from the home tab replaces it, like typing a URL into Chrome's new tab page.
      if (replaceHome && idx >= 0 && next[idx]!.source === null) next.splice(idx, 1, ...created);
      else next.splice(idx + 1, 0, ...created);
      return next;
    });
    setActiveId(files[files.length - 1]!.id);
    for (const f of files) {
      if (f.remote) {
        setRecents(rememberRecent({ name: f.name, size: f.size, remote: f.remote }));
      } else {
        setRecents(rememberRecent({ name: f.name, path: f.path, size: f.size }));
      }
    }
  }, [activeId]);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.id === id);
      if (i < 0) return prev;
      prev[i]!.source?.release();
      const next = prev.filter((t) => t.id !== id);
      if (!next.length) next.push(homeTab());
      if (id === activeId) setActiveId(next[Math.min(i, next.length - 1)]!.id);
      return next;
    });
  }, [activeId]);

  /** Open (or focus) a page tab: Sharing, or a remote computer's folders. */
  const openPage = useCallback((page: Page, replaceActive = false) => {
    const t: Tab = { id: `page-${Math.random().toString(36).slice(2)}`, source: null, page };
    setTabs((prev) => {
      if (page.kind === "sharing") {
        const existing = prev.find((x) => x.page?.kind === "sharing");
        if (existing) {
          setActiveId(existing.id);
          return prev;
        }
      }
      const i = prev.findIndex((x) => x.id === activeId);
      const next = [...prev];
      if (i >= 0 && (replaceActive ? !next[i]!.source && !next[i]!.page : false)) next.splice(i, 1, t);
      else next.splice(i + 1, 0, t);
      setActiveId(t.id);
      return next;
    });
  }, [activeId]);

  const navigateRemote = useCallback((tabId: string, location: RemoteLocation) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId && t.page?.kind === "remote" ? { ...t, page: { ...t.page, location } } : t)));
  }, []);

  const newTab = useCallback(() => {
    const t = homeTab();
    setTabs((prev) => [...prev, t]);
    setActiveId(t.id);
  }, []);

  const pick = useCallback(async () => {
    try {
      openFiles(await bridge.pickFiles());
    } catch (err) {
      setNotice((err as Error).message);
    }
  }, [bridge, openFiles]);

  const openPath = useCallback(async (path: string) => {
    if (!bridge.openPath) return;
    try {
      openFiles([await bridge.openPath(path)]);
    } catch (err) {
      setNotice(`Could not open ${path}: ${(err as Error).message}`);
    }
  }, [bridge, openFiles]);

  const reopenRecent = useCallback(async (r: Recent) => {
    if (r.remote) {
      await reopenRemoteRecent(r, {
        hosts,
        transport: bridge.remoteTransport,
        onNotice: setNotice,
        onOpen: (source) => openFiles([source]),
      });
      return;
    }
    if (r.path) {
      void openPath(r.path);
    }
  }, [bridge, hosts, openFiles, openPath]);

  // Files from the OS: file associations, second instance, share/VIEW intents.
  useEffect(() => bridge.onExternalOpen((files) => openFiles(files)), [bridge, openFiles]);

  // External open errors from the OS (e.g. unreadable shared files).
  useEffect(() => bridge.onExternalOpenError?.((err) => setNotice(err)), [bridge]);

  // Keyboard shortcuts, Chrome-style.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "o") { e.preventDefault(); void pick(); }
      else if (k === "t") { e.preventDefault(); newTab(); }
      else if (k === "w") { e.preventDefault(); closeTab(activeId); }
      else if (k === "l") { e.preventDefault(); document.getElementById("omnibox")?.focus(); }
      else if (e.key === "Tab") {
        e.preventDefault();
        const i = tabs.findIndex((t) => t.id === activeId);
        const n = (i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length;
        setActiveId(tabs[n]!.id);
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const n = e.key === "9" ? tabs.length - 1 : Number(e.key) - 1;
        if (tabs[n]) setActiveId(tabs[n]!.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, activeId, pick, newTab, closeTab]);

  // Android back navigation.
  useEffect(() => {
    const onBack = (e: Event) => {
      if (e.defaultPrevented) return;
      if (pairing) {
        e.preventDefault();
        setPairing(false);
        return;
      }
      if (active.page?.kind === "remote" && active.page.location?.root) {
        e.preventDefault();
        const loc = active.page.location;
        const trimmed = (loc.path || "").replace(/[\/\\]$/, "");
        if (trimmed) {
          const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
          const parent = i >= 0 ? trimmed.slice(0, i) : "";
          navigateRemote(activeId, { ...loc, path: parent });
        } else {
          navigateRemote(activeId, { root: undefined, path: "" });
        }
        return;
      }
      if (active.source || active.page || tabs.length > 1) {
        e.preventDefault();
        closeTab(activeId);
        return;
      }
    };
    window.addEventListener("uniview:back", onBack);
    return () => window.removeEventListener("uniview:back", onBack);
  }, [pairing, active, activeId, tabs.length, navigateRemote, closeTab]);

  // Drag-and-drop anywhere.
  useEffect(() => {
    const has = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => { if (has(e)) { dragDepth.current++; setDragging(true); } };
    const leave = () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); };
    const over = (e: DragEvent) => { if (has(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!has(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      const electronPath = (f: File) => (window as unknown as { uniview?: { pathOf?: (f: File) => string } }).uniview?.pathOf?.(f);
      const paths = files.map(electronPath);
      if (bridge.openPath && paths.every(Boolean)) {
        // Desktop: reopen through the main process so the grant, streaming and recents use the real path.
        void Promise.all(paths.map((p) => bridge.openPath!(p!))).then((s) => openFiles(s), (err: Error) => setNotice(err.message));
      } else {
        openFiles(files.map((f) => blobSource(f, f.name)));
      }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [bridge, openFiles]);

  useEffect(() => {
    const t = active.source ? active.source.name : pageTitle(active, hosts);
    document.title = `${t} – UniView`;
  }, [active, hosts]);

  const hostFor = (hostId: string) => hosts.find((h) => h.hostId === hostId);

  const onDetected = useCallback((id: string, d: Detection) => setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, detection: d } : t))), []);
  const onReady = useCallback((tab: Tab, ms: number) => {
    (window.__univiewMetrics ??= []).push({ name: tab.source?.name ?? "", kind: tab.detection?.kind, ms: Math.round(ms) });
  }, []);

  return (
    <div className="app">
      <header className="chrome">
        <div className="tabstrip" role="tablist" aria-label="Open files">
          {tabs.map((t) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === activeId}
              className={`tab ${t.id === activeId ? "active" : ""}`}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } }}
              onClick={() => setActiveId(t.id)}
              title={t.source ? `${t.source.path ?? t.source.name}\n${t.detection?.label ?? ""} · ${formatBytes(t.source.size)}` : "New tab"}
            >
              {t.source ? <KindBadge kind={t.detection?.kind} small /> : <span className="tab-home" aria-hidden>{t.page?.kind === "sharing" ? "⇄" : t.page?.kind === "remote" ? "🖥" : "⌂"}</span>}
              <span className="tab-title">{t.source?.name ?? pageTitle(t, hosts)}</span>
              <button className="tab-close" aria-label={`Close ${t.source?.name ?? "tab"}`} onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>×</button>
            </div>
          ))}
          <button className="tab-new" onClick={newTab} aria-label="New tab" title="New tab (Ctrl+T)">+</button>
        </div>
        <Omnibox
          active={active}
          tabs={tabs}
          recents={recents}
          canOpenPath={!!bridge.openPath}
          onPick={pick}
          onSwitch={setActiveId}
          onOpenPath={openPath}
          onReveal={active.source && bridge.revealInFolder ? () => bridge.revealInFolder!(active.source!) : undefined}
        />
      </header>
      {notice && (
        <div className="banner warn" role="alert">
          {notice}
          <button className="link" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      <main className="content">
        {tabs.map((t) => (
          <div key={t.id} className="tab-panel" hidden={t.id !== activeId} role="tabpanel">
            {t.source ? (
              <TabView source={t.source} onDetected={(d) => onDetected(t.id, d)} onReady={(ms) => onReady(t, ms)} onOpen={(f) => openFiles(f, false)} />
            ) : t.page?.kind === "sharing" && bridge.share ? (
              <SharingPanel share={bridge.share} />
            ) : t.page?.kind === "remote" && bridge.remoteTransport && hostFor(t.page.hostId) ? (
              <RemoteBrowser
                record={hostFor(t.page.hostId)!}
                transport={bridge.remoteTransport}
                location={t.page.location}
                onNavigate={(loc) => navigateRemote(t.id, loc)}
                onOpen={(f) => openFiles(f, false)}
              />
            ) : (
              <Home
                recents={recents}
                canReopen={!!bridge.openPath}
                canReopenRemote={!!bridge.remoteTransport}
                onPick={pick}
                onReopen={reopenRecent}
                onForget={(r) => setRecents(forgetRecent(r))}
                hosts={bridge.remoteTransport ? hosts : null}
                onConnect={() => setPairing(true)}
                onBrowse={(h) => openPage({ kind: "remote", hostId: h.hostId, location: { path: "" } }, true)}
                onForgetHost={(h) => {
                  disconnect(h.hostId);
                  setHosts(forgetHost(h.hostId));
                }}
                onShare={bridge.share ? () => openPage({ kind: "sharing" }, true) : undefined}
              />
            )}
          </div>
        ))}
      </main>
      {pairing && bridge.remoteTransport && (
        <PairDialog
          transport={bridge.remoteTransport}
          canScan={!!bridge.canScanQr}
          onClose={() => setPairing(false)}
          onPaired={(h) => {
            setPairing(false);
            setHosts(loadHosts());
            openPage({ kind: "remote", hostId: h.hostId, location: { path: "" } }, true);
          }}
        />
      )}
      {dragging && (
        <div className="drop-overlay" aria-hidden>
          <div className="drop-card">Drop files to open them</div>
        </div>
      )}
    </div>
  );
}

function Omnibox({ active, tabs, recents, canOpenPath, onPick, onSwitch, onOpenPath, onReveal }: {
  active: Tab;
  tabs: Tab[];
  recents: Recent[];
  canOpenPath: boolean;
  onPick: () => void;
  onSwitch: (id: string) => void;
  onOpenPath: (p: string) => void;
  onReveal?: () => void;
}) {
  const [value, setValue] = useState<string | null>(null);
  const shown = value ?? (active.source ? active.source.path ?? active.source.name : "");
  const q = (value ?? "").trim().toLowerCase();
  const matches = q
    ? [
        ...tabs.filter((t) => t.source && t.source.name.toLowerCase().includes(q)).map((t) => ({ kind: "tab" as const, label: t.source!.name, id: t.id, detail: "Open tab" })),
        ...recents.filter((r) => r.name.toLowerCase().includes(q) && (canOpenPath ? !!r.path : true)).slice(0, 6).map((r) => ({ kind: "recent" as const, label: r.name, id: r.path ?? r.name, detail: r.path ?? "Recent" })),
      ].slice(0, 8)
    : [];
  const looksLikePath = canOpenPath && /^(?:[a-zA-Z]:[\\/]|\/|\\\\|~)/.test(value ?? "");
  const submit = () => {
    const v = (value ?? "").trim();
    if (looksLikePath) onOpenPath(v);
    else if (matches[0]) choose(matches[0]);
    setValue(null);
    (document.activeElement as HTMLElement | null)?.blur();
  };
  const choose = (m: (typeof matches)[number]) => {
    if (m.kind === "tab") onSwitch(m.id);
    else if (canOpenPath && m.id) onOpenPath(m.id);
    setValue(null);
  };
  return (
    <div className="omnibar">
      <button className="omni-open" onClick={onPick} title="Open files (Ctrl+O)">Open</button>
      <div className="omnibox-wrap">
        <span className="omni-icon" aria-hidden>{active.source ? <KindBadge kind={active.detection?.kind} small /> : "🔍"}</span>
        <input
          id="omnibox"
          className="omnibox"
          value={shown}
          placeholder={canOpenPath ? "Search open tabs and recent files, or paste a file path" : "Search open tabs and recent files"}
          spellCheck={false}
          autoComplete="off"
          onFocus={(e) => { setValue(""); requestAnimationFrame(() => e.target.select()); }}
          onBlur={() => setTimeout(() => setValue(null), 150)}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") { setValue(null); e.currentTarget.blur(); }
          }}
          aria-label="Address and search"
        />
        {active.detection && value === null && <span className="omni-meta">{active.detection.label} · {formatBytes(active.source?.size ?? -1)}</span>}
        {(matches.length > 0 || looksLikePath) && value !== null && (
          <ul className="omni-suggest" role="listbox">
            {looksLikePath && <li role="option" aria-selected onMouseDown={(e) => { e.preventDefault(); submit(); }}><strong>Open</strong> {value}</li>}
            {matches.map((m) => (
              <li key={m.kind + m.id} role="option" aria-selected={false} onMouseDown={(e) => { e.preventDefault(); choose(m); }}>
                <span>{m.label}</span>
                <span className="muted small ellipsis">{m.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {onReveal && <button className="omni-reveal" onClick={onReveal} title="Show in folder">📂</button>}
    </div>
  );
}

function pageTitle(t: Tab, hosts: HostRecord[]): string {
  if (t.page?.kind === "sharing") return "Sharing";
  if (t.page?.kind === "remote") {
    const p = t.page;
    const host = hosts.find((h) => h.hostId === p.hostId)?.hostName ?? "Computer";
    const leaf = p.location.path.split("/").filter(Boolean).pop() ?? p.location.root?.name;
    return leaf ? `${leaf} – ${host}` : host;
  }
  return "New tab";
}

function Home({ recents, canReopen, canReopenRemote, onPick, onReopen, onForget, hosts, onConnect, onBrowse, onForgetHost, onShare }: {
  recents: Recent[];
  canReopen: boolean;
  canReopenRemote?: boolean;
  onPick: () => void;
  onReopen: (r: Recent) => void;
  onForget: (r: Recent) => void;
  hosts: HostRecord[] | null;
  onConnect: () => void;
  onBrowse: (h: HostRecord) => void;
  onForgetHost: (h: HostRecord) => void;
  onShare?: () => void;
}) {
  return (
    <div className="home">
      <div className="home-hero">
        <div className="logo" aria-hidden>U</div>
        <h1>UniView</h1>
        <p className="muted">Open any file. Offline, private, instant.</p>
        <button className="primary big" onClick={onPick} data-testid="open-button">Open files</button>
        <p className="muted small">or drop files anywhere · Ctrl+O</p>
      </div>
      <div className="home-formats" aria-label="Supported formats">
        {(["pdf", "docx", "sheet", "pptx", "epub", "image", "video", "audio", "markdown", "text", "zip", "font"] as FormatKind[]).map((k) => (
          <span key={k} className="format-chip"><KindBadge kind={k} small /> {badgeFor(k).name}</span>
        ))}
      </div>
      {(hosts || onShare) && (
        <section className="recents computers" aria-label="Your computers">
          <div className="section-head">
            <h2>Your computers</h2>
            <div className="row">
              {onShare && <button onClick={onShare} data-testid="open-sharing">Share this computer…</button>}
              {hosts && <button onClick={onConnect} data-testid="connect-computer">Connect a computer…</button>}
            </div>
          </div>
          {hosts && hosts.length > 0 ? (
            <ul>
              {hosts.map((h) => (
                <li key={h.hostId}>
                  <button className="recent" onClick={() => onBrowse(h)} data-testid="browse-host">
                    <span className="recent-name">🖥 {h.hostName}</span>
                    <span className="muted small ellipsis">Browse shared folders · end-to-end encrypted</span>
                  </button>
                  <button className="link small" onClick={() => onForgetHost(h)} aria-label={`Forget ${h.hostName}`}>Forget</button>
                </li>
              ))}
            </ul>
          ) : (
            hosts && <p className="muted small">Open files on your other computer without copying them. Connect over your local network; no account or cloud.</p>
          )}
        </section>
      )}
      {recents.length > 0 && (
        <section className="recents">
          <h2>Recent</h2>
          <ul>
            {recents.slice(0, 12).map((r) => {
              const host = r.remote ? hosts?.find((h) => h.hostId === r.remote!.hostId) : undefined;
              const computerName = host?.hostName ?? "Computer";
              const canOpen = r.remote ? !!canReopenRemote : (canReopen && !!r.path);
              return (
                <li key={r.remote ? `${r.remote.hostId}:${r.remote.rootId}:${r.remote.path}` : (r.path ?? "") + r.name}>
                  <button
                    className="recent"
                    disabled={!canOpen}
                    onClick={() => onReopen(r)}
                    title={
                      r.remote
                        ? `${r.name} on ${computerName}`
                        : canReopen
                          ? r.path
                          : "Reopen by choosing the file again"
                    }
                  >
                    <span className="recent-name">{r.name}</span>
                    <span className="muted small ellipsis">
                      {r.remote ? `🖥 ${computerName}` : (r.path ?? formatBytes(r.size))}
                    </span>
                  </button>
                  <button className="link small" onClick={() => onForget(r)} aria-label={`Remove ${r.name} from recent`}>Remove</button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
