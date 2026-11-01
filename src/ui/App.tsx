import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Detection, FileSource, FormatKind } from "../core/types";
import { blobSource } from "../shells/sources";
import { getBridge } from "../shells";
import { formatBytes } from "../core/errors";
import { TabView } from "./TabView";
import { badgeFor, KindBadge } from "./badges";
import { loadRecents, rememberRecent, forgetRecent, type Recent } from "./recents";
import { SharingPanel } from "./remote/SharingPanel";
import { AgentsPanel } from "./AgentsPanel";
import { PairDialog } from "./remote/PairDialog";
import { RemoteBrowser, type RemoteLocation } from "./remote/RemoteBrowser";
import { forgetHost, loadHosts } from "../remote/store";
import { disconnect } from "../remote/connections";
import { reopenRemoteRecent } from "../remote/reopen-recent";
import type { HostRecord } from "../../shared/remote-client.mjs";
import logoUrl from "./assets/logo.png";
import { setTheme, type Theme } from "./theme";
import ReviewTab from "../viewers/ReviewTab";
import { scopeIdOf, hasElectronApi, type AgentConnectStatusResult } from "../shells/electron";
import { AgentBar, type AgentBarMessage } from "./AgentBar";

const MAX_LINES_PER_SESSION = 200;

type Page = { kind: "sharing" } | { kind: "agents" } | { kind: "remote"; hostId: string; location: RemoteLocation };

interface Tab {
  id: string;
  source: FileSource | null; // null = home tab (or a page)
  detection?: Detection;
  page?: Page;
  scopeId?: string;
  agentReview?: any;
  agentSupplied?: boolean;
  sessionId?: string;
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
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [activeId, setActiveId] = useState(() => tabs[0]!.id);
  const [dragging, setDragging] = useState(false);
  const [recents, setRecents] = useState<Recent[]>(() => loadRecents());
  const [notice, setNotice] = useState<string | null>(null);
  const [hosts, setHosts] = useState<HostRecord[]>(() => loadHosts());
  const [pairing, setPairing] = useState(false);
  const [sessionStates, setSessionStates] = useState<Record<string, string>>({});
  const [messagesBySession, setMessagesBySession] = useState<Record<string, AgentBarMessage[]>>({});
  const [draftsBySession, setDraftsBySession] = useState<Record<string, string>>({});
  const [errorsBySession, setErrorsBySession] = useState<Record<string, string | null>>({});
  const [showOmnibox, setShowOmnibox] = useState(false);
  const dragDepth = useRef(0);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;

  const openFiles = useCallback((files: FileSource[], replaceHome = true) => {
    if (!files.length) return;
    const current = tabsRef.current;
    const next = [...current];
    const created: Tab[] = [];
    const toRelease: FileSource[] = [];
    let focusedId: string | null = null;

    const norm = (p: string) => p.toLowerCase();

    for (const f of files) {
      const sessionId = (f as any).sessionId;
      const fPath = f.path;
      // Only reload in place for agent opens (has sessionId); compare case-insensitively like Windows.
      const existingIdx = sessionId && fPath
        ? next.findIndex((t) => t.source?.path && norm(t.source.path) === norm(fPath))
        : -1;
      if (existingIdx >= 0) {
        const oldTab = next[existingIdx]!;
        if (oldTab.source) toRelease.push(oldTab.source);
        // A viewspec or receipt tab keeps its detection across a reload; a plain file tab lets TabView re-detect.
        const keepDetection =
          oldTab.detection?.kind === "viewspec" || oldTab.detection?.kind === "receipt";
        next[existingIdx] = {
          ...oldTab,
          source: f,
          detection: keepDetection ? oldTab.detection : undefined,
          scopeId: (f as any).scopeId ?? scopeIdOf(f),
          sessionId,
        };
        focusedId = oldTab.id;
      } else {
        created.push({
          id: f.id,
          source: f,
          scopeId: (f as any).scopeId ?? scopeIdOf(f),
          sessionId,
        });
      }
    }

    if (created.length > 0) {
      const idx = next.findIndex((t) => t.id === activeId);
      // Opening from the home tab replaces it, like typing a URL into Chrome's new tab page.
      if (replaceHome && idx >= 0 && next[idx]!.source === null) next.splice(idx, 1, ...created);
      else next.splice(idx + 1, 0, ...created);
      focusedId = created[created.length - 1]!.id;
    }

    // Release old scopes outside the updater so release runs exactly once.
    for (const s of toRelease) {
      try {
        s.release();
      } catch {}
    }

    setTabs(next);
    if (focusedId) setActiveId(focusedId);
    else if (next.length > 0) setActiveId(next[next.length - 1]!.id);

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
          const keepDetection =
            t.detection?.kind === "viewspec" || t.detection?.kind === "receipt";
          return {
            ...t,
            source: fresh,
            detection: keepDetection ? t.detection : undefined,
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

  // Agent subscriptions for message, session state, and View > Agents (subscribed once)
  useEffect(() => {
    const electron = (window as any).uniview;
    if (!electron) return;

    const unsubTheme = electron.onTheme?.((t: string) => setTheme(t as Theme));

    const unsubMsg = electron.onAgentMessage?.((msg: { sessionId: string; text: string }) => {
      if (!msg?.sessionId || !msg?.text) return;
      setMessagesBySession((prev) => ({
        ...prev,
        [msg.sessionId]: [
          ...(prev[msg.sessionId] || []),
          { id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`, sender: "agent", text: msg.text },
        ].slice(-MAX_LINES_PER_SESSION) as AgentBarMessage[],
      }));
    });

    const unsubState = electron.onAgentSessionState?.((st: { sessionId: string; state: string }) => {
      if (!st?.sessionId || !st?.state) return;
      setSessionStates((prev) => ({
        ...prev,
        [st.sessionId]: st.state,
      }));
    });

    const unsubOpenAgents = electron.onOpenAgents?.(() => {
      openPage({ kind: "agents" }, false);
    });

    return () => {
      unsubMsg?.();
      unsubState?.();
      unsubOpenAgents?.();
      unsubTheme?.();
    };
  }, [openPage]);

  // Test-only hooks: the preload exposes e2eHooks only under UNIVIEW_E2E=1, so the shipped app never gets them.
  useEffect(() => {
    if (!(window as any).uniview?.e2eHooks) return;
    (window as any).__univiewOpenPage = openPage;
    (window as any).__univiewSetPairing = setPairing;
  }, [openPage, setPairing]);

  const handleAgentSend = useCallback(async (sessionId: string, text: string, documentPath?: string) => {
    const electron = (window as any).uniview;
    if (!electron?.sendMessage) {
      throw new Error("Agent messaging not available");
    }
    setErrorsBySession((prev) => ({ ...prev, [sessionId]: null }));
    const res = await electron.sendMessage({ sessionId, text, documentPath });
    if (res && res.ok === false) {
      const errMsg = res.error || "Failed to send message";
      setErrorsBySession((prev) => ({ ...prev, [sessionId]: errMsg }));
      throw new Error(errMsg);
    }
    setMessagesBySession((prev) => ({
      ...prev,
      [sessionId]: [
        ...(prev[sessionId] || []),
        { id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`, sender: "person", text },
      ],
    }));
  }, []);

  const handleAgentEnd = useCallback(async (sessionId: string) => {
    const electron = (window as any).uniview;
    if (!electron?.endSession) return;
    try {
      await electron.endSession(sessionId);
    } catch (err: unknown) {
      setErrorsBySession((prev) => ({
        ...prev,
        [sessionId]: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

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
      else if (k === "n") {
        e.preventDefault();
        (window as unknown as { uniview?: { newWindow?: () => void } }).uniview?.newWindow?.();
      }
      else if (k === "w") { e.preventDefault(); closeTab(activeId); }
      else if (k === "r") { e.preventDefault(); void reloadActiveTab(); }
      else if (k === "l") {
        e.preventDefault();
        setShowOmnibox((prev) => !prev);
        setTimeout(() => document.getElementById("omnibox")?.focus(), 50);
      }
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
          <button className="top-open" onClick={pick} title="Open files (Ctrl+O)">Open</button>
        </div>
        {showOmnibox && (
          <Omnibox
            active={active}
            tabs={tabs}
            recents={recents}
            canOpenPath={!!bridge.openPath}
            onPick={pick}
            onSwitch={(id) => { setActiveId(id); setShowOmnibox(false); }}
            onOpenPath={(p) => { openPath(p); setShowOmnibox(false); }}
            onReveal={active.source && bridge.revealInFolder ? () => bridge.revealInFolder!(active.source!) : undefined}
            onHome={() => { goHome(); setShowOmnibox(false); }}
          />
        )}
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
                key={t.source.id}
                source={t.source}
                active={t.id === activeId}
                initialReview={t.agentReview}
                onOpen={(f) => openFiles(f, false)}
              />
            ) : t.source ? (
              <TabView
                key={t.source.id}
                source={t.source}
                detection={t.agentSupplied ? t.detection : undefined}
                onDetected={(d) => { onDetected(t.id, d); }}
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
                onPick={pick}
                onReopen={reopenRecent}
                onForget={(r) => setRecents(forgetRecent(r))}
              />
            )}
            {t.source && t.sessionId && (
              <AgentBar
                sessionId={t.sessionId}
                documentPath={t.source.path}
                state={sessionStates[t.sessionId]}
                isKnown={sessionStates[t.sessionId] !== "disconnected"}
                messages={messagesBySession[t.sessionId] ?? []}
                draft={draftsBySession[t.sessionId] ?? ""}
                onDraftChange={(d) => setDraftsBySession((prev) => ({ ...prev, [t.sessionId!]: d }))}
                onSend={(text) => handleAgentSend(t.sessionId!, text, t.source?.path)}
                onEnd={() => handleAgentEnd(t.sessionId!)}
                error={errorsBySession[t.sessionId]}
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

function Home({
  recents,
  canReopen,
  onPick,
  onReopen,
  onForget,
}: {
  recents: Recent[];
  canReopen: boolean;
  onPick: () => void;
  onReopen: (r: Recent) => void;
  onForget: (r: Recent) => void;
}) {
  const [connectStatus, setConnectStatus] = useState<AgentConnectStatusResult | null>(null);
  const [confirmClient, setConfirmClient] = useState<"claude" | "codex" | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [busyClient, setBusyClient] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const electron = (window as any).uniview;
    if (electron?.connectStatus) {
      try {
        const res = await electron.connectStatus();
        setConnectStatus(res);
      } catch {
        setConnectStatus(null);
      }
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleConnect = async (client: "claude" | "codex") => {
    const electron = (window as any).uniview;
    if (!electron?.connect) return;
    setBusyClient(client);
    setConnectError(null);
    try {
      const res = await electron.connect(client);
      if (!res.ok) {
        setConnectError(res.error || `Failed to connect ${client}`);
      } else {
        setConfirmClient(null);
        await refreshStatus();
      }
    } catch (err: unknown) {
      setConnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyClient(null);
    }
  };

  const handleDisconnect = async (client: "claude" | "codex") => {
    const electron = (window as any).uniview;
    if (!electron?.disconnect) return;
    setBusyClient(client);
    setConnectError(null);
    try {
      const res = await electron.disconnect(client);
      if (!res.ok) {
        setConnectError(res.error || `Failed to disconnect ${client}`);
      } else {
        await refreshStatus();
      }
    } catch (err: unknown) {
      setConnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyClient(null);
    }
  };

  const renderClientItem = (client: "claude" | "codex", name: string) => {
    const st = connectStatus?.[client];
    let stateLabel = "";
    if (st) {
      if (!st.installed) {
        stateLabel = "Not installed";
      } else if (st.connected) {
        stateLabel = st.stale ? "Reconnect (stale)" : "Connected";
      }
    }

    // A client that is not installed gets no Connect button: there is nothing to connect to yet.
    const showConnect = !!st?.installed && (!st.connected || st.stale);
    const isConfirming = confirmClient === client;

    return (
      <div key={client} className="home-agent-item-wrap">
        <div className="home-agent-item">
          <span className="home-agent-name">{name}</span>
          {!st?.installed ? null : showConnect ? (
            <button
              type="button"
              className="link small"
              onClick={() => {
                setConnectError(null);
                setConfirmClient(isConfirming ? null : client);
              }}
              disabled={busyClient === client}
            >
              Connect
            </button>
          ) : (
            <button
              type="button"
              className="link small"
              onClick={() => void handleDisconnect(client)}
              disabled={busyClient === client}
            >
              Disconnect
            </button>
          )}
          {stateLabel && <span className="home-agent-state">{stateLabel}</span>}
        </div>

        {isConfirming && (
          <div className="home-agent-confirm" role="region" aria-label={`Connect ${name}`}>
            <p className="home-agent-confirm-text">
              {client === "claude"
                ? "This adds UniView to Claude Code's user settings using its own command."
                : "This adds a UniView section to your Codex config.toml, and keeps a backup."}
            </p>
            {connectError && (
              <div className="home-agent-error" role="alert">
                {connectError}
              </div>
            )}
            <div className="home-agent-confirm-actions">
              <button
                type="button"
                className="primary small"
                disabled={busyClient === client}
                onClick={() => void handleConnect(client)}
              >
                Connect
              </button>
              <button
                type="button"
                className="small"
                onClick={() => {
                  setConfirmClient(null);
                  setConnectError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="home">
      {/* 1. Drop zone with an Open file button */}
      <div className="home-dropzone" onClick={onPick}>
        <button
          type="button"
          className="primary big"
          onClick={(e) => {
            e.stopPropagation();
            onPick();
          }}
          data-testid="open-button"
        >
          Open file
        </button>
        <span className="muted small">or drop files anywhere</span>
      </div>

      {/* 2. Compact AI agents row */}
      <div className="home-agents-row" aria-label="AI agents">
        <div className="home-agents-clients">
          {renderClientItem("claude", "Claude Code")}
          {renderClientItem("codex", "Codex")}
        </div>
        {connectError && !confirmClient && (
          <div className="home-agent-error" role="alert">
            {connectError}
          </div>
        )}
      </div>

      {/* 3. Plain recent files list, no thumbnails */}
      {recents.length > 0 && (
        <section className="recents" aria-label="Recent files">
          <h2>Recent</h2>
          <ul>
            {recents.slice(0, 12).map((r) => {
              const canOpen = !!r.remote || (canReopen && !!r.path);
              return (
                <li key={r.path ?? r.name}>
                  <button
                    type="button"
                    className="recent plain"
                    disabled={!canOpen}
                    onClick={() => onReopen(r)}
                    title={canOpen ? r.path : "Reopen by choosing the file again"}
                  >
                    <span className="recent-name">{r.name}</span>
                    <span className="muted small ellipsis">
                      {r.path ?? formatBytes(r.size)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="link small"
                    onClick={() => onForget(r)}
                    aria-label={`Remove ${r.name} from recent`}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
