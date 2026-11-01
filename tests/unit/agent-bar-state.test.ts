import { describe, expect, it } from "vitest";
import { getAgentBarState } from "../../src/ui/agent-bar-state";

describe("agent-bar-state", () => {
  it("returns 'Agent is listening' with canSend and showEscHint when wait is open (listening / waiting)", () => {
    const listening = getAgentBarState("listening", true);
    expect(listening.label).toBe("Agent is listening");
    expect(listening.canSend).toBe(true);
    expect(listening.showEscHint).toBe(true);

    const waiting = getAgentBarState("waiting", true);
    expect(waiting.label).toBe("Agent is listening");
    expect(waiting.canSend).toBe(true);
    expect(waiting.showEscHint).toBe(true);
  });

  it("returns 'Working…' with canSend true and showEscHint false when working or idle", () => {
    const working = getAgentBarState("working", true);
    expect(working.label).toBe("Working…");
    expect(working.canSend).toBe(true);
    expect(working.showEscHint).toBe(false);

    const idle = getAgentBarState("idle", true);
    expect(idle.label).toBe("Working…");
    expect(idle.canSend).toBe(true);
    expect(idle.showEscHint).toBe(false);
  });

  it("returns 'Message queued. The agent will get it when it next checks' when queued", () => {
    const queued = getAgentBarState("queued", true);
    expect(queued.label).toBe("Message queued. The agent will get it when it next checks");
    expect(queued.canSend).toBe(true);
    expect(queued.showEscHint).toBe(false);
  });

  it("returns 'Conversation ended' with canSend false when closed", () => {
    const closed = getAgentBarState("closed", true);
    expect(closed.label).toBe("Conversation ended");
    expect(closed.canSend).toBe(false);
    expect(closed.showEscHint).toBe(false);
  });

  it("returns 'Agent disconnected' with canSend false when disconnected or unknown", () => {
    const disconnected = getAgentBarState("disconnected", true);
    expect(disconnected.label).toBe("Agent disconnected");
    expect(disconnected.canSend).toBe(false);
    expect(disconnected.showEscHint).toBe(false);

    const notKnown = getAgentBarState("waiting", false);
    expect(notKnown.label).toBe("Agent disconnected");
    expect(notKnown.canSend).toBe(false);
    expect(notKnown.showEscHint).toBe(false);

    const undefNotKnown = getAgentBarState(undefined, false);
    expect(undefNotKnown.label).toBe("Agent disconnected");
    expect(undefNotKnown.canSend).toBe(false);
    expect(undefNotKnown.showEscHint).toBe(false);
  });

  it("falls back to 'Working…' for unrecognized known states", () => {
    const other = getAgentBarState("custom-state", true);
    expect(other.label).toBe("Working…");
    expect(other.canSend).toBe(true);
    expect(other.showEscHint).toBe(false);
  });
});
