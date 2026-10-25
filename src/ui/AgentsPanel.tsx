import React, { useEffect, useState, useCallback, useMemo } from "react";
import type { AgentsApi, AgentSessionInfo, EnrolledClientInfo, AgentActivityEntry } from "../shells/electron";
import { hasElectronApi } from "../shells/electron";
import { sanitizeLabel } from "../viewers/agent-markdown";

export interface AgentsPanelProps {
  agents?: AgentsApi;
}

/**
 * Agents panel (P17b-2): Lists connected sessions, permanently enrolled agents,
 * and the activity audit log with revocation and refresh controls.
 *
 * Trust model:
 * Names and versions are self-reported by agents and are treated as untrusted text.
 * They are sanitized via sanitizeLabel and rendered strictly as plain text.
 */
export function AgentsPanel({ agents: agentsProp }: AgentsPanelProps): React.ReactElement {
  const api = useMemo<AgentsApi | null>(() => {
    if (agentsProp) return agentsProp;
    if (hasElectronApi() && (window as any).uniview?.agents) {
      return (window as any).uniview.agents;
    }
    return null;
  }, [agentsProp]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const [clients, setClients] = useState<EnrolledClientInfo[]>([]);
  const [activity, setActivity] = useState<AgentActivityEntry[]>([]);
  const [confirmRevoke, setConfirmRevoke] = useState<EnrolledClientInfo | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    if (!api) {
      setLoading(false);
      return;
    }
    try {
      const res = await api.list();
      if (!res.ok) {
        setError(res.error || "Failed to load agents information");
      } else {
        setError(null);
        setSessions(Array.isArray(res.sessions) ? res.sessions : []);
        setClients(
          Array.isArray(res.clients)
            ? res.clients
            : Array.isArray(res.enrolledClients)
              ? res.enrolledClients
              : []
        );
        setActivity(Array.isArray(res.activity) ? res.activity : []);
      }
    } catch (err: any) {
      setError(err?.message || "Failed to connect to agent host");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleRefresh = async () => {
    if (!api || isRefreshing) return;
    setIsRefreshing(true);
    try {
      await loadData();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleConfirmRevoke = async () => {
    if (!api || !confirmRevoke || isRevoking) return;
    setIsRevoking(true);
    try {
      const res = await api.revoke({ clientId: confirmRevoke.clientId });
      if (!res.ok) {
        setError(res.error || "Failed to revoke client");
      } else {
        setConfirmRevoke(null);
        await loadData();
      }
    } catch (err: any) {
      setError(err?.message || "Failed to revoke client");
    } finally {
      setIsRevoking(false);
    }
  };

  if (loading) {
    return <div className="center-msg">Loading agents…</div>;
  }

  return (
    <div className="scroll sharing agents-panel" data-testid="agents-panel">
      <div className="sharing-inner agents-inner">
        <header className="sharing-head agents-head">
          <h1>Agents</h1>
          <p className="muted">
            Connected agent sessions, permanently enrolled tools, and recent activity log.
          </p>
        </header>

        {error && (
          <div className="banner warn" role="alert">
            {error}
          </div>
        )}

        {/* Connected Sessions */}
        <section className="card">
          <div className="card-head">
            <h2>Connected sessions ({sessions.length})</h2>
          </div>
          {sessions.length === 0 ? (
            <p className="muted small agents-empty">No active agent sessions.</p>
          ) : (
            <ul className="plain-list">
              {sessions.map((s) => {
                const name = sanitizeLabel(s.client?.name || "Unknown agent", 80);
                const version = sanitizeLabel(s.client?.version || "", 40);
                const started = s.openedAt ? new Date(s.openedAt).toLocaleString() : "Unknown";
                const tabsCount = typeof s.openTabs === "number" ? s.openTabs : 0;
                const reviewsCount = typeof s.pendingReviews === "number" ? s.pendingReviews : 0;
                return (
                  <li key={s.sessionId}>
                    <div className="session-info">
                      <span className="session-name">
                        <strong>{name}</strong>
                        <span
                          className="self-reported-hint muted small"
                          title="This name is reported by the agent and cannot be verified by UniView"
                        >
                          {" "}(self-reported)
                        </span>
                        {version && <span className="muted small"> v{version}</span>}
                      </span>
                      <span className="muted small block session-meta">
                        Started: {started} · Open tabs: {tabsCount} · Pending reviews: {reviewsCount}
                        {s.kind ? ` · ${s.kind.toUpperCase()}` : ""}
                        {s.approval ? ` (${s.approval})` : ""}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Enrolled Clients */}
        <section className="card">
          <div className="card-head">
            <h2>Enrolled agents ({clients.length})</h2>
          </div>
          {clients.length === 0 ? (
            <p className="muted small agents-empty">No enrolled agents.</p>
          ) : (
            <ul className="plain-list">
              {clients.map((c) => {
                const name = sanitizeLabel(c.name || "Unknown agent", 80);
                const enrolled = c.enrolledAt ? new Date(c.enrolledAt).toLocaleString() : "Unknown";
                return (
                  <li key={c.clientId}>
                    <div>
                      <strong>{name}</strong>
                      <span className="self-reported-hint muted small"> (self-reported)</span>
                      <span className="muted small block">Enrolled: {enrolled}</span>
                    </div>
                    <button
                      type="button"
                      className="link danger small"
                      data-testid={`revoke-${c.clientId}`}
                      onClick={() => setConfirmRevoke(c)}
                    >
                      Revoke
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Activity Log */}
        <section className="card">
          <div className="card-head">
            <h2>Activity ({activity.length})</h2>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              data-testid="refresh-activity"
            >
              {isRefreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {activity.length === 0 ? (
            <p className="muted small agents-empty">No activity recorded yet.</p>
          ) : (
            <ul className="plain-list log" data-testid="access-log">
              {activity.map((a, i) => {
                const time = a.at ? new Date(a.at).toLocaleTimeString() : "";
                const type = sanitizeLabel(a.type, 40);
                const client = a.client ? sanitizeLabel(a.client, 80) : "";
                const detail = a.detail ? sanitizeLabel(a.detail, 200) : "";
                return (
                  <li key={i}>
                    <span>
                      {client && <strong>{client} </strong>}
                      <span className="badge small">{type}</span>
                      {detail && <span className="muted"> {detail}</span>}
                    </span>
                    <span className="muted small">{time}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {/* Confirmation Modal */}
      {confirmRevoke && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="revoke-modal-title"
          data-testid="confirm-revoke-modal"
          onKeyDown={(e) => {
            if (e.key === "Escape") setConfirmRevoke(null);
          }}
        >
          <div className="modal">
            <h2 id="revoke-modal-title">
              Revoke “{sanitizeLabel(confirmRevoke.name || "Agent", 80)}”?
            </h2>
            <p className="muted small">
              Revoking will delete this agent's enrolled key, cancel any pending reviews or waits, and immediately close all of its active sessions.
            </p>
            <div className="row right">
              <button
                type="button"
                className="cancel-revoke"
                data-testid="cancel-revoke"
                onClick={() => setConfirmRevoke(null)}
                disabled={isRevoking}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary danger"
                data-testid="confirm-revoke"
                onClick={handleConfirmRevoke}
                disabled={isRevoking}
              >
                {isRevoking ? "Revoking…" : "Revoke enrollment"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AgentsPanel;
