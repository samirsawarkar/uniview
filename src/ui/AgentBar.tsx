import React, { useEffect, useRef, useState } from "react";
import { getAgentBarState } from "./agent-bar-state";

export interface AgentBarMessage {
  id: string;
  sender: "person" | "agent";
  text: string;
}

export interface AgentBarProps {
  sessionId: string;
  documentPath?: string;
  state?: string;
  isKnown?: boolean;
  messages: AgentBarMessage[];
  draft: string;
  onDraftChange: (draft: string) => void;
  onSend: (text: string) => Promise<void>;
  onEnd: () => Promise<void>;
  error?: string | null;
}

export function AgentBar({
  state,
  isKnown = true,
  messages,
  draft,
  onDraftChange,
  onSend,
  onEnd,
  error,
}: AgentBarProps): React.ReactElement {
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const stateInfo = getAgentBarState(state, isKnown);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages.length]);

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || !stateInfo.canSend || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await onSend(text);
      onDraftChange("");
    } catch (err: unknown) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const handleEnd = async () => {
    try {
      await onEnd();
    } catch (err: unknown) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  };

  const effectiveError = sendError || error;

  return (
    <div className="agent-bar" role="region" aria-label="Agent conversation">
      {messages.length > 0 && (
        <div className="agent-bar-messages" aria-label="Message history">
          {messages.map((m) => (
            <div key={m.id} className={`agent-bar-message ${m.sender}`}>
              <strong className={`agent-bar-sender ${m.sender}`}>
                {m.sender === "person" ? "You: " : "Agent: "}
              </strong>
              <span className="agent-bar-text">{m.text}</span>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}

      <div className="agent-bar-status-row">
        <span className="agent-bar-status">{stateInfo.label}</span>
        {stateInfo.showEscHint && (
          <span className="agent-bar-hint">
            Your terminal shows the agent waiting. Press Esc there to take back control.
          </span>
        )}
      </div>

      {effectiveError && (
        <div className="agent-bar-error" role="alert">
          {effectiveError}
        </div>
      )}

      <div className="agent-bar-form">
        <textarea
          className="agent-bar-input"
          value={draft}
          placeholder={
            stateInfo.canSend
              ? "Type a change request for the agent…"
              : state === "closed"
              ? "Conversation ended"
              : "Agent disconnected"
          }
          disabled={!stateInfo.canSend}
          rows={1}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          aria-label="Message for agent"
        />
        <button
          type="button"
          className="agent-bar-send primary"
          disabled={!stateInfo.canSend || !draft.trim() || sending}
          onClick={() => void handleSend()}
        >
          Send
        </button>
        <button
          type="button"
          className="agent-bar-end"
          disabled={state === "closed"}
          onClick={() => void handleEnd()}
        >
          End
        </button>
      </div>
    </div>
  );
}
