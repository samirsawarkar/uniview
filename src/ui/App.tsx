import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Detection, FileSource, FormatKind } from "../core/types";
import { blobSource } from "../shells/sources";
import { getBridge } from "../shells";
import { formatBytes } from "../core/errors";
import { TabView } from "./TabView";
import { badgeFor, KindBadge } from "./badges";
import { loadRecents, rememberRecent, forgetRecent, type Recent } from "./recents";
import { RecentThumb, captureRecentThumb } from "./recent-thumbs";
import { SharingPanel } from "./remote/SharingPanel";
import { AgentsPanel } from "./AgentsPanel";
import { PairDialog } from "./remote/PairDialog";
import { RemoteBrowser, type RemoteLocation } from "./remote/RemoteBrowser";
import { forgetHost, loadHosts } from "../remote/store";
import { disconnect } from "../remote/connections";
import { reopenRemoteRecent } from "../remote/reopen-recent";
import type { HostRecord } from "../../shared/remote-client.mjs";
import logoUrl from "./assets/logo.png";
import { getTheme, setTheme, type Theme } from "./theme";
import ReviewTab from "../viewers/ReviewTab";
import { scopeIdOf, hasElectronApi } from "../shells/electron";

type Page = { kind: "sharing" } | { kind: "agents" } | { kind: "remote"; hostId: string; location: RemoteLocation };

interface Tab {
  id: string;
  source: FileSource | null; // null = home tab (or a page)
  detection?: Detection;
  page?: Page;
  scopeId?: string;
  agentReview?: any;
  agentSupplied?: boolean;
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
      const created = files.map((f) => ({
        id: f.id,
        source: f,
        scopeId: (f as any).scopeId ?? scopeIdOf(f),
      }));
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
      const tab = prev[i]!;
      tab.source?.release();
      if (tab.scopeId && hasElectronApi()) {
        try {
          (window as any).uniview?.tabClosed?.(tab.scopeId);
        } catch {}
      }
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
      if (page.kind === "sharing" || page.kind === "agents") {
        const existing = prev.find((x) => x.page?.kind === page.kind);
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

  const goHome = useCallback(() => {
    const existing = tabs.find((t) => !t.source && !t.page);
    if (existing) {
      setActiveId(existing.id);
    } else {
      const t = homeTab();
      setTabs((prev) => [...prev, t]);
      setActiveId(t.id);
    }
  }, [tabs]);

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

  const reloadActiveTab = useCallback(async () => {
    if (!active.source?.reopen) return;
    try {
      const fresh = await active.source.reopen();
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== activeId) return t;
          const isAgent = Boolean(
            t.agentSupplied &&
              (t.detection?.kind === "viewspec" || t.detection?.kind === "receipt")
          );
          return {
            ...t,
            source: fresh,
            detection: isAgent ? t.detection : undefined,
          };
        })
      );
    } catch {}
  }, [active, activeId]);

  useEffect(() => {
    (window as any).__univiewReloadActiveTab = reloadActiveTab;
  }, [reloadActiveTab]);

  // Files from the OS: file associations, second instance, share/VIEW intents.
  useEffect(() => bridge.onExternalOpen((files) => openFiles(files)), [bridge, openFiles]);

  // Agent subscriptions for view, review, and close-tab events
  useEffect(() => {
    const electron = (window as any).uniview;
    if (!electron) return;

    const unsubView = electron.onAgentShowView?.((item: any) => {
      if (!item?.scopeId) return;
      const specBytes =
        item.specBytes instanceof Uint8Array
          ? item.specBytes
          : new Uint8Array(item.specBytes?.data ?? item.specBytes ?? []);
      const source: FileSource = {
        id: `agent-view-${item.scopeId}`,
        name: item.spec?.title || "Agent View",
        size: specBytes.byteLength,
        path: undefined,
        readAll: async () => specBytes.buffer.slice(specBytes.byteOffset, specBytes.byteOffset + specBytes.byteLength),
        readRange: async (start, end) => specBytes.subarray(start, end).buffer.slice(0),
        url: async () => "",
        release: () => {
          electron.tabClosed?.(item.scopeId);
        },
      };
      const newTab: Tab = {
        id: `tab-${item.scopeId}`,
        source,
        detection: { kind: "viewspec", label: "View Spec", ext: ".viewspec.json", by: "container" },
        scopeId: item.scopeId,
        agentSupplied: true,
      };
      setTabs((prev) => {
        const next = [...prev];
        const idx = next.findIndex((t) => t.id === activeId);
        if (idx >= 0 && next[idx]!.source === null && !next[idx]!.page) {
          next.splice(idx, 1, newTab);
        } else {
          next.push(newTab);
        }
        return next;
      });
      setActiveId(newTab.id);
    });

    const unsubReview = electron.onAgentShowReview?.((item: any) => {
      if (!item?.scopeId) return;
      const receiptBytes =
        item.receiptBytes instanceof Uint8Array
          ? item.receiptBytes
          : new Uint8Array(item.receiptBytes?.data ?? item.receiptBytes ?? []);
      const source: FileSource = {
        id: `agent-review-${item.scopeId}`,
        name: `${item.receipt?.agent?.name || "agent"}.receipt.json`,
        size: receiptBytes.byteLength,
        path: undefined,
        readAll: async () => receiptBytes.buffer.slice(receiptBytes.byteOffset, receiptBytes.byteOffset + receiptBytes.byteLength),
        readRange: async (start, end) => receiptBytes.subarray(start, end).buffer.slice(0),
        url: async () => "",
        release: () => {
          electron.tabClosed?.(item.scopeId);
        },
      };
      const newTab: Tab = {
        id: `tab-${item.scopeId}`,
        source,
        detection: { kind: "receipt", label: "Review receipt", ext: ".receipt.json", by: "container" },
        scopeId: item.scopeId,
        agentReview: item,
        agentSupplied: true,
      };
      setTabs((prev) => {
        const next = [...prev];
        const idx = next.findIndex((t) => t.id === activeId);
        if (idx >= 0 && next[idx]!.source === null && !next[idx]!.page) {
          next.splice(idx, 1, newTab);
        } else {
          next.push(newTab);
        }
        return next;
      });
      setActiveId(newTab.id);
    });

    const unsubClose = electron.onAgentCloseTab?.((scopeId: string) => {
      if (!scopeId) return;
      setTabs((prev) => {
        const tab = prev.find(
          (t) => t.scopeId === scopeId || t.id === `tab-${scopeId}` || (t.source as any)?.scopeId === scopeId
        );
        if (!tab) return prev;
        tab.source?.release();
        const next = prev.filter((t) => t.id !== tab.id);
        if (!next.length) next.push(homeTab());
        const idx = prev.indexOf(tab);
        if (tab.id === activeId) setActiveId(next[Math.min(idx, next.length - 1)]!.id);
        return next;
      });
    });

    return () => {
      unsubView?.();
      unsubReview?.();
      unsubClose?.();
    };
  }, [activeId]);

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
      else if (k === "r") { e.preventDefault(); void reloadActiveTab(); }
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
      const viewer = new Event("uniview:back:viewer", { cancelable: true });
      window.dispatchEvent(viewer);
      if (viewer.defaultPrevented) {
        e.preventDefault();
        return;
      }
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
  }, [pairing, active, activeId, tabs, navigateRemote, closeTab]);

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

  const onDetected = useCallback((id: string, d: Detection) => setTabs((prev) => prev.map((t) => (t.id === id ? (t.detection === d ? t : { ...t, detection: d }) : t))), []);
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
              {t.source ? <KindBadge kind={t.detection?.kind} small /> : <span className="tab-home" aria-hidden>{t.page?.kind === "sharing" ? "⇄" : t.page?.kind === "agents" ? "🤖" : t.page?.kind === "remote" ? "🖥" : <img className="tab-logo" src={logoUrl} alt="" />}</span>}
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
          onHome={goHome}
          onAgents={bridge.agents ? () => openPage({ kind: "agents" }, false) : undefined}
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
            {t.agentReview && t.source ? (
              <ReviewTab
                source={t.source}
                active={t.id === activeId}
                initialReview={t.agentReview}
                onOpen={(f) => openFiles(f, false)}
              />
            ) : t.source ? (
              <TabView
                source={t.source}
                detection={t.agentSupplied ? t.detection : undefined}
                onDetected={(d) => { onDetected(t.id, d); if (!t.source!.remote) void captureRecentThumb(bridge, t.source!, d.kind); }}
                onReady={(ms) => onReady(t, ms)}
                onOpen={(f) => openFiles(f, false)}
                active={t.id === activeId}
              />
            ) : t.page?.kind === "sharing" && bridge.share ? (
              <SharingPanel share={bridge.share} />
            ) : t.page?.kind === "agents" ? (
              <AgentsPanel agents={bridge.agents} />
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
                onAgents={bridge.agents ? () => openPage({ kind: "agents" }, true) : undefined}
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

function Omnibox({ active, tabs, recents, canOpenPath, onPick, onSwitch, onOpenPath, onReveal, onHome, onAgents }: {
  active: Tab;
  tabs: Tab[];
  recents: Recent[];
  canOpenPath: boolean;
  onPick: () => void;
  onSwitch: (id: string) => void;
  onOpenPath: (p: string) => void;
  onReveal?: () => void;
  onHome: () => void;
  onAgents?: () => void;
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
      <button
        className="home-button"
        onClick={onHome}
        aria-label="Home"
        title="Home"
        data-testid="home-button"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      </button>
      {onAgents && (
        <button
          className="home-button agents-btn"
          onClick={onAgents}
          aria-label="Agents"
          title="Agents"
          data-testid="header-agents"
        >
          🤖
        </button>
      )}
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
  if (t.page?.kind === "agents") return "Agents";
  if (t.page?.kind === "remote") {
    const p = t.page;
    const host = hosts.find((h) => h.hostId === p.hostId)?.hostName ?? "Computer";
    const leaf = p.location.path.split("/").filter(Boolean).pop() ?? p.location.root?.name;
    return leaf ? `${leaf} – ${host}` : host;
  }
  return "New tab";
}

function Home({ recents, canReopen, canReopenRemote, onPick, onReopen, onForget, hosts, onConnect, onBrowse, onForgetHost, onShare, onAgents }: {
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
  onAgents?: () => void;
}) {
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  const handleTheme = (t: Theme) => {
    setTheme(t);
    setThemeState(t);
  };

  return (
    <div className="home">
      <div className="home-hero">
        <img className="logo" src={logoUrl} alt="" />
        <h1>UniView</h1>
        <p className="muted">Open any file. Offline, private, instant.</p>
      </div>

      <div className="home-actions">
        <button className="action-card primary" onClick={onPick} data-testid="open-button">
          <span className="action-card-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          <strong className="action-card-title">Open files</strong>
          <span className="muted small action-card-sub">
            {canReopen ? "PDF, Office, images, video and more · or drop files anywhere · Ctrl+O" : "PDF, Office, images, video and more"}
          </span>
        </button>

        {hosts !== null && (
          <button className="action-card" onClick={onConnect} data-testid="connect-computer">
            <span className="action-card-icon" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="2" y1="20" x2="22" y2="20" />
              </svg>
            </span>
            <strong className="action-card-title">Connect a computer</strong>
            <span className="muted small action-card-sub">Browse a PC or Mac on your Wi-Fi</span>
          </button>
        )}

        {onShare && (
          <button className="action-card" onClick={onShare} data-testid="open-sharing">
            <span className="action-card-icon" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
              </svg>
            </span>
            <strong className="action-card-title">Share this computer</strong>
            <span className="muted small action-card-sub">Let your phone browse folders you choose</span>
          </button>
        )}

        {onAgents && (
          <button className="action-card" onClick={onAgents} data-testid="open-agents">
            <span className="action-card-icon" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <circle cx="12" cy="5" r="2" />
                <path d="M12 7v4" />
                <line x1="8" y1="16" x2="8" y2="16" />
                <line x1="16" y1="16" x2="16" y2="16" />
              </svg>
            </span>
            <strong className="action-card-title">Agents</strong>
            <span className="muted small action-card-sub">Connected sessions, enrolled tools and activity</span>
          </button>
        )}
      </div>

      {hosts && hosts.length > 0 && (
        <section className="recents computers" aria-label="Your computers">
          <div className="section-head">
            <h2>Your computers</h2>
          </div>
          <ul>
            {hosts.map((h) => (
              <li key={h.hostId}>
                <button className="recent" onClick={() => onBrowse(h)} data-testid="browse-host">
                  <span className="recent-name">🖥 {h.hostName}</span>
                  <span className="muted small ellipsis">Browse shared folders · end-to-end encrypted</span>
                </button>
                <button
                  className="link danger small"
                  onClick={() => onForgetHost(h)}
                  data-testid={`pair-forget-${h.hostId}`}
                  aria-label={`Forget ${h.hostName}`}
                  title="Forget this computer"
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
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
                    <RecentThumb recent={r} />
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

      <div className="home-formats" aria-label="Supported formats">
        {(["pdf", "docx", "sheet", "pptx", "epub", "image", "video", "audio", "markdown", "text", "zip", "font"] as FormatKind[]).map((k) => (
          <span key={k} className="format-chip"><KindBadge kind={k} small /> {badgeFor(k).name}</span>
        ))}
      </div>

      <div className="theme-control" role="radiogroup" aria-label="Appearance">
        <span className="muted small">Appearance</span>
        <div className="theme-segmented">
          <button
            type="button"
            role="radio"
            aria-checked={theme === "light"}
            className={theme === "light" ? "active" : ""}
            data-testid="theme-light"
            onClick={() => handleTheme("light")}
          >
            Light
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={theme === "dark"}
            className={theme === "dark" ? "active" : ""}
            data-testid="theme-dark"
            onClick={() => handleTheme("dark")}
          >
            Dark
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={theme === "system"}
            className={theme === "system" ? "active" : ""}
            data-testid="theme-system"
            onClick={() => handleTheme("system")}
          >
            System
          </button>
        </div>
      </div>
    </div>
  );
}
