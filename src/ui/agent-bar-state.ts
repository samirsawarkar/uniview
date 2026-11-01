export interface AgentBarStateOutput {
  label: string;
  canSend: boolean;
  showEscHint: boolean;
}

/**
 * Pure state calculation for the document agent bar.
 * Exact labels from the spec:
 * - "Agent is listening" when a wait is open (state "listening" or "waiting")
 * - "Working…" after delivery or when idle (state "idle" or "working")
 * - "Message queued. The agent will get it when it next checks" when queued with no wait open
 * - "Conversation ended" when closed (state "closed")
 * - "Agent disconnected" when gone (state "disconnected" or session not known)
 */
export function getAgentBarState(
  state: string | undefined | null,
  isKnown: boolean
): AgentBarStateOutput {
  if (!isKnown || state === "disconnected") {
    return {
      label: "Agent disconnected",
      canSend: false,
      showEscHint: false,
    };
  }

  if (state === "closed") {
    return {
      label: "Conversation ended",
      canSend: false,
      showEscHint: false,
    };
  }

  if (state === "listening" || state === "waiting") {
    return {
      label: "Agent is listening",
      canSend: true,
      showEscHint: true,
    };
  }

  if (state === "queued") {
    return {
      label: "Message queued. The agent will get it when it next checks",
      canSend: true,
      showEscHint: false,
    };
  }

  if (state === "idle" || state === "working") {
    return {
      label: "Working…",
      canSend: true,
      showEscHint: false,
    };
  }

  // Fallback for an unrecognized known state
  return {
    label: "Working…",
    canSend: true,
    showEscHint: false,
  };
}
