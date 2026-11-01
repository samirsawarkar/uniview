import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentBar } from "../../src/ui/AgentBar";

describe("AgentBar component (jsdom)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders messages in plain text nodes and shows listening status with Esc hint", () => {
    const messages = [
      { id: "1", sender: "agent" as const, text: "Hello from agent" },
      { id: "2", sender: "person" as const, text: "Hello from person" },
    ];

    act(() => {
      root.render(
        <AgentBar
          sessionId="s-1"
          state="listening"
          isKnown={true}
          messages={messages}
          draft=""
          onDraftChange={() => {}}
          onSend={async () => {}}
          onEnd={async () => {}}
        />
      );
    });

    expect(container.textContent).toContain("Hello from agent");
    expect(container.textContent).toContain("Hello from person");
    expect(container.textContent).toContain("Agent is listening");
    expect(container.textContent).toContain("Your terminal shows the agent waiting. Press Esc there to take back control.");

    const textarea = container.querySelector("textarea")!;
    expect(textarea).toBeDefined();
    expect(textarea.disabled).toBe(false);
  });

  it("disables send when closed and shows 'Conversation ended'", () => {
    act(() => {
      root.render(
        <AgentBar
          sessionId="s-1"
          state="closed"
          isKnown={true}
          messages={[]}
          draft="pending change"
          onDraftChange={() => {}}
          onSend={async () => {}}
          onEnd={async () => {}}
        />
      );
    });

    expect(container.textContent).toContain("Conversation ended");
    const sendBtn = container.querySelector(".agent-bar-send") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    const endBtn = container.querySelector(".agent-bar-end") as HTMLButtonElement;
    expect(endBtn.disabled).toBe(true);
  });

  it("calls onSend when Send button is clicked and shows error if onSend rejects while keeping draft", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("Inbox is full (maximum 100 messages)"));
    const onDraftChange = vi.fn();

    act(() => {
      root.render(
        <AgentBar
          sessionId="s-1"
          state="working"
          isKnown={true}
          messages={[]}
          draft="change something"
          onDraftChange={onDraftChange}
          onSend={onSend}
          onEnd={async () => {}}
        />
      );
    });

    const sendBtn = container.querySelector(".agent-bar-send") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);

    await act(async () => {
      sendBtn.click();
    });

    expect(onSend).toHaveBeenCalledWith("change something");
    expect(onDraftChange).not.toHaveBeenCalledWith(""); // Draft is kept!
    expect(container.textContent).toContain("Inbox is full (maximum 100 messages)");
  });

  it("calls onEnd when End button is clicked", async () => {
    const onEnd = vi.fn().mockResolvedValue(undefined);

    act(() => {
      root.render(
        <AgentBar
          sessionId="s-1"
          state="working"
          isKnown={true}
          messages={[]}
          draft=""
          onDraftChange={() => {}}
          onSend={async () => {}}
          onEnd={onEnd}
        />
      );
    });

    const endBtn = container.querySelector(".agent-bar-end") as HTMLButtonElement;
    await act(async () => {
      endBtn.click();
    });

    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
