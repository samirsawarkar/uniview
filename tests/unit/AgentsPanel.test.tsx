import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentsPanel } from "../../src/ui/AgentsPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createMockAgentsApi(overrides: Partial<any> = {}) {
  const sessions = overrides.sessions ?? [
    {
      sessionId: "sess-1",
      kind: "mcp",
      client: { name: "Agent Claude", version: "2.1.0" },
      approval: "always",
      clientId: "client-1",
      openedAt: "2026-10-25T01:00:00.000Z",
      pendingReviews: 2,
      openTabs: 3,
    },
  ];

  const clients = overrides.clients ?? [
    {
      clientId: "client-1",
      name: "Agent Claude",
      enrolledAt: "2026-10-25T00:30:00.000Z",
    },
  ];

  const activity = overrides.activity ?? [
    {
      at: "2026-10-25T01:10:00.000Z",
      type: "open",
      sessionId: "sess-1",
      client: "Agent Claude",
      detail: "3 file(s)",
    },
  ];

  return {
    list: vi.fn(async () => ({
      ok: true,
      sessions,
      clients,
      activity,
    })),
    revoke: vi.fn(async ({ clientId }: { clientId: string }) => ({
      ok: true,
      removed: true,
      sessionsClosed: 1,
    })),
    activity: vi.fn(async ({ limit }: { limit: number }) => ({
      ok: true,
      activity: activity.slice(-limit),
    })),
    ...overrides,
  };
}

describe("AgentsPanel UI", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
    }
    container?.remove();
    container = null;
    root = null;
    delete (window as any).uniview;
  });

  async function flush() {
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  // Mutation caught: AgentsPanel fails to render sessions, clients or activity
  it("renders connected sessions, enrolled clients, and activity log", async () => {
    const api = createMockAgentsApi();

    await act(async () => {
      root!.render(<AgentsPanel agents={api} />);
    });
    await flush();

    expect(api.list).toHaveBeenCalledTimes(1);

    const text = container?.textContent ?? "";
    // Connected sessions
    expect(text).toContain("Agent Claude");
    expect(text).toContain("self-reported");
    expect(text).toContain("2.1.0");
    expect(text).toContain("Open tabs");
    expect(text).toContain("3");
    expect(text).toContain("Pending reviews");
    expect(text).toContain("2");

    // Enrolled clients
    expect(text).toContain("Enrolled agents");
    expect(container?.querySelector("[data-testid='revoke-client-1']")).not.toBeNull();

    // Activity log
    expect(text).toContain("Activity");
    expect(text).toContain("open");
    expect(text).toContain("3 file(s)");
  });

  // Mutation caught: AgentsPanel fails to render empty states when arrays are empty
  it("renders empty states when there are no sessions, enrolled clients, or activity", async () => {
    const api = createMockAgentsApi({
      sessions: [],
      clients: [],
      activity: [],
    });

    await act(async () => {
      root!.render(<AgentsPanel agents={api} />);
    });
    await flush();

    const text = container?.textContent?.toLowerCase() ?? "";
    expect(text).toContain("no active agent sessions");
    expect(text).toContain("no enrolled agents");
    expect(text).toContain("no activity recorded");
  });

  // Mutation caught: revoke calls api.revoke immediately without waiting for confirmation
  it("revoke calls api.revoke once and only after confirmation in the UI", async () => {
    let clientsList = [
      {
        clientId: "client-1",
        name: "Agent Claude",
        enrolledAt: "2026-10-25T00:30:00.000Z",
      },
    ];

    const api = createMockAgentsApi({
      list: vi.fn(async () => ({
        ok: true,
        sessions: [],
        clients: clientsList,
        activity: [],
      })),
      revoke: vi.fn(async ({ clientId }: { clientId: string }) => {
        clientsList = clientsList.filter((c) => c.clientId !== clientId);
        return { ok: true, removed: true, sessionsClosed: 1 };
      }),
    });

    await act(async () => {
      root!.render(<AgentsPanel agents={api} />);
    });
    await flush();

    const revokeBtn = container?.querySelector("[data-testid='revoke-client-1']") as HTMLButtonElement;
    expect(revokeBtn).not.toBeNull();

    // 1. Click initial Revoke button
    await act(async () => {
      revokeBtn.click();
    });
    await flush();

    // Confirmation dialog must appear, and api.revoke must NOT have been called yet
    expect(api.revoke).not.toHaveBeenCalled();
    const modal = container?.querySelector("[role='dialog'], [data-testid='confirm-revoke-modal']");
    expect(modal).not.toBeNull();
    expect(modal?.textContent).toContain("Revoke");
    expect(modal?.textContent).toContain("Agent Claude");

    // 2. Click Cancel in modal
    const cancelBtn = modal?.querySelector("button[data-testid='cancel-revoke'], button.cancel-revoke, button:not(.primary):not(.danger)") as HTMLButtonElement;
    expect(cancelBtn).not.toBeNull();
    await act(async () => {
      cancelBtn.click();
    });
    await flush();

    // Dialog dismissed and still NO revoke call
    expect(api.revoke).not.toHaveBeenCalled();
    expect(container?.querySelector("[role='dialog'], [data-testid='confirm-revoke-modal']")).toBeNull();

    // 3. Click initial Revoke button again
    const revokeBtnAgain = container?.querySelector("[data-testid='revoke-client-1']") as HTMLButtonElement;
    await act(async () => {
      revokeBtnAgain.click();
    });
    await flush();

    // 4. Click Confirm Revoke in modal
    const confirmBtn = container?.querySelector("[data-testid='confirm-revoke']") as HTMLButtonElement;
    expect(confirmBtn).not.toBeNull();

    await act(async () => {
      confirmBtn.click();
    });
    await flush();

    // Now api.revoke must have been called exactly once
    expect(api.revoke).toHaveBeenCalledTimes(1);
    expect(api.revoke).toHaveBeenCalledWith({ clientId: "client-1" });

    // The list must have refreshed
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  // Mutation caught: UI renders untrusted names with raw control/bidi characters or HTML injection
  it("sanitises untrusted agent names before rendering as plain text", async () => {
    const toxicName = "Evil\u0000\u001fAgent\u202E\u2066RLO\u200E<img src=x onerror=alert(1)>";

    const api = createMockAgentsApi({
      sessions: [
        {
          sessionId: "sess-toxic",
          kind: "mcp",
          client: { name: toxicName, version: "1.0" },
          approval: "always",
          clientId: "client-toxic",
          openedAt: "2026-10-25T01:00:00.000Z",
          pendingReviews: 0,
          openTabs: 0,
        },
      ],
      clients: [
        {
          clientId: "client-toxic",
          name: toxicName,
          enrolledAt: "2026-10-25T00:30:00.000Z",
        },
      ],
    });

    await act(async () => {
      root!.render(<AgentsPanel agents={api} />);
    });
    await flush();

    // No HTML image element should have been injected into the DOM
    expect(container?.querySelector("img[src='x']")).toBeNull();

    // Bidi and control characters should be stripped
    const html = container?.innerHTML ?? "";
    expect(html).not.toMatch(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/);
  });

  // Mutation caught: activity refresh button calls api.list reloading entire panel instead of only api.activity
  it("activity refresh button re-fetches only the activity via api.activity", async () => {
    const api = createMockAgentsApi();

    await act(async () => {
      root!.render(<AgentsPanel agents={api} />);
    });
    await flush();

    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.activity).not.toHaveBeenCalled();

    const refreshBtn = container?.querySelector("[data-testid='refresh-activity']") as HTMLButtonElement;
    expect(refreshBtn).not.toBeNull();

    await act(async () => {
      refreshBtn.click();
    });
    await flush();

    // Must NOT call api.list again
    expect(api.list).toHaveBeenCalledTimes(1);
    // Must call api.activity
    expect(api.activity).toHaveBeenCalledTimes(1);
  });

  // Mutation caught: Revoke buttons share generic accessible name instead of 'Revoke <client name>'
  it("Revoke buttons have sanitized accessible names 'Revoke <client name>'", async () => {
    const api = createMockAgentsApi({
      clients: [
        { clientId: "c1", name: "Agent Claude\u202E", enrolledAt: "2026-10-25T00:00:00.000Z" },
        { clientId: "c2", name: "Agent Codex", enrolledAt: "2026-10-25T00:00:00.000Z" },
      ],
    });

    await act(async () => {
      root!.render(<AgentsPanel agents={api} />);
    });
    await flush();

    const btn1 = container?.querySelector("[data-testid='revoke-c1']") as HTMLButtonElement;
    const btn2 = container?.querySelector("[data-testid='revoke-c2']") as HTMLButtonElement;

    expect(btn1.getAttribute("aria-label")).toBe("Revoke Agent Claude");
    expect(btn2.getAttribute("aria-label")).toBe("Revoke Agent Codex");
  });

  // Mutation caught: Revoke dialog does not move focus to Cancel button on open
  it("moves focus to the Cancel button when revoke dialog opens", async () => {
    const api = createMockAgentsApi();

    await act(async () => {
      root!.render(<AgentsPanel agents={api} />);
    });
    await flush();

    const revokeBtn = container?.querySelector("[data-testid='revoke-client-1']") as HTMLButtonElement;
    await act(async () => {
      revokeBtn.click();
    });
    await flush();

    const cancelBtn = container?.querySelector("[data-testid='cancel-revoke']") as HTMLButtonElement;
    expect(document.activeElement).toBe(cancelBtn);
  });

  // Mutation caught: Escape key at document level does not close the dialog
  it("closes revoke dialog on Escape key at document level", async () => {
    const api = createMockAgentsApi();

    await act(async () => {
      root!.render(<AgentsPanel agents={api} />);
    });
    await flush();

    const revokeBtn = container?.querySelector("[data-testid='revoke-client-1']") as HTMLButtonElement;
    await act(async () => {
      revokeBtn.click();
    });
    await flush();

    expect(container?.querySelector("[role='dialog']")).not.toBeNull();

    (document.activeElement as HTMLElement)?.blur();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();

    expect(container?.querySelector("[role='dialog']")).toBeNull();
  });

  // Mutation caught: Tab does not cycle focus within the dialog (focus traps)
  it("traps Tab key inside the confirmation dialog", async () => {
    const api = createMockAgentsApi();

    await act(async () => {
      root!.render(<AgentsPanel agents={api} />);
    });
    await flush();

    const revokeBtn = container?.querySelector("[data-testid='revoke-client-1']") as HTMLButtonElement;
    await act(async () => {
      revokeBtn.click();
    });
    await flush();

    const cancelBtn = container?.querySelector("[data-testid='cancel-revoke']") as HTMLButtonElement;
    const confirmBtn = container?.querySelector("[data-testid='confirm-revoke']") as HTMLButtonElement;

    expect(document.activeElement).toBe(cancelBtn);

    // Shift+Tab from cancel wraps to confirm
    await act(async () => {
      cancelBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(confirmBtn);

    // Tab from confirm wraps to cancel
    await act(async () => {
      confirmBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: false, bubbles: true }));
    });
    expect(document.activeElement).toBe(cancelBtn);
  });

  // Mutation caught: closing the dialog does not restore focus to the opening button
  it("restores focus to the opening Revoke button when dialog is closed", async () => {
    const api = createMockAgentsApi();

    await act(async () => {
      root!.render(<AgentsPanel agents={api} />);
    });
    await flush();

    const revokeBtn = container?.querySelector("[data-testid='revoke-client-1']") as HTMLButtonElement;
    revokeBtn.focus();
    expect(document.activeElement).toBe(revokeBtn);

    await act(async () => {
      revokeBtn.click();
    });
    await flush();

    const cancelBtn = container?.querySelector("[data-testid='cancel-revoke']") as HTMLButtonElement;
    await act(async () => {
      cancelBtn.click();
    });
    await flush();

    expect(document.activeElement).toBe(revokeBtn);
  });

  // Mutation caught: failed revoke hides error banner behind modal instead of showing inside
  it("shows error inside the modal when revoke fails", async () => {
    const api = createMockAgentsApi({
      revoke: vi.fn(async () => ({
        ok: false,
        error: "Revocation rejected by security policy",
      })),
    });

    await act(async () => {
      root!.render(<AgentsPanel agents={api} />);
    });
    await flush();

    const revokeBtn = container?.querySelector("[data-testid='revoke-client-1']") as HTMLButtonElement;
    await act(async () => {
      revokeBtn.click();
    });
    await flush();

    const confirmBtn = container?.querySelector("[data-testid='confirm-revoke']") as HTMLButtonElement;
    await act(async () => {
      confirmBtn.click();
    });
    await flush();

    const modal = container?.querySelector(".modal");
    expect(modal).not.toBeNull();
    const modalError = modal?.querySelector("[role='alert']");
    expect(modalError).not.toBeNull();
    expect(modalError?.textContent).toContain("Revocation rejected by security policy");
  });

  // Mutation caught: backdrop click does not dismiss the confirmation dialog
  it("cancels and closes the confirmation dialog on backdrop click", async () => {
    const api = createMockAgentsApi();

    await act(async () => {
      root!.render(<AgentsPanel agents={api} />);
    });
    await flush();

    const revokeBtn = container?.querySelector("[data-testid='revoke-client-1']") as HTMLButtonElement;
    await act(async () => {
      revokeBtn.click();
    });
    await flush();

    const backdrop = container?.querySelector(".modal-backdrop") as HTMLDivElement;
    expect(backdrop).not.toBeNull();

    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container?.querySelector(".modal-backdrop")).toBeNull();
  });

  // Mutation caught: rapid double click invokes api.revoke multiple times without useRef guard
  it("guards against double-clicking confirm revoke button using useRef guard", async () => {
    let resolveRevoke: (val: any) => void;
    const revokePromise = new Promise((resolve) => {
      resolveRevoke = resolve;
    });

    const api = createMockAgentsApi({
      revoke: vi.fn(() => revokePromise),
    });

    await act(async () => {
      root!.render(<AgentsPanel agents={api} />);
    });
    await flush();

    const revokeBtn = container?.querySelector("[data-testid='revoke-client-1']") as HTMLButtonElement;
    await act(async () => {
      revokeBtn.click();
    });
    await flush();

    const confirmBtn = container?.querySelector("[data-testid='confirm-revoke']") as HTMLButtonElement;

    // Simulate two rapid clicks
    await act(async () => {
      confirmBtn.click();
      confirmBtn.click();
    });

    expect(api.revoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRevoke!({ ok: true, removed: true, sessionsClosed: 1 });
    });
    await flush();

    expect(api.revoke).toHaveBeenCalledTimes(1);
  });

  // Mutation caught: AgentsPanel renders empty lists instead of unavailable state when agents API is missing
  it("renders 'Agents are not available in this build' when no agents API exists", async () => {
    await act(async () => {
      root!.render(<AgentsPanel />);
    });
    await flush();

    const text = container?.textContent ?? "";
    expect(text).toContain("Agents are not available in this build");
    expect(text).not.toContain("Connected sessions");
    expect(text).not.toContain("No active agent sessions");
  });

  // Mutation caught: Activity section lacks Show more button to load older entries up to 500
  it("loads older entries (up to 500) with a Show more button", async () => {
    const initialActivity = Array.from({ length: 100 }, (_, i) => ({
      at: "2026-10-25T01:00:00.000Z",
      type: "open",
      sessionId: `s-${i}`,
      client: "Agent Claude",
      detail: `file ${i}`,
    }));
    const expandedActivity = Array.from({ length: 200 }, (_, i) => ({
      at: "2026-10-25T01:00:00.000Z",
      type: "open",
      sessionId: `s-${i}`,
      client: "Agent Claude",
      detail: `file ${i}`,
    }));

    const activityMock = vi.fn(async ({ limit }: { limit: number }) => ({
      ok: true,
      activity: expandedActivity.slice(-limit),
    }));

    const api = createMockAgentsApi({
      activity: initialActivity,
      list: vi.fn(async () => ({
        ok: true,
        sessions: [],
        clients: [],
        activity: initialActivity,
      })),
    });
    api.activity = activityMock;

    await act(async () => {
      root!.render(<AgentsPanel agents={api} />);
    });
    await flush();

    const showMoreBtn = container?.querySelector("[data-testid='show-more-activity']") as HTMLButtonElement;
    expect(showMoreBtn).not.toBeNull();
    expect(showMoreBtn?.textContent).toContain("Show more");

    await act(async () => {
      showMoreBtn.click();
    });
    await flush();

    expect(activityMock).toHaveBeenCalledWith({ limit: 200 });
    const logItems = container?.querySelectorAll("[data-testid='access-log'] li");
    expect(logItems?.length).toBe(200);
  });

  // Mutation caught: activity timestamp shows only time or produces 'Invalid Date' for malformed dates
  it("renders date and time for activity and never renders 'Invalid Date'", async () => {
    const api = createMockAgentsApi({
      activity: [
        {
          at: "2026-10-25T14:30:45.000Z",
          type: "open",
          client: "Agent Claude",
          detail: "file.txt",
        },
        {
          at: "not-a-real-date",
          type: "open",
          client: "Agent Claude",
          detail: "invalid-date.txt",
        },
      ],
      sessions: [
        {
          sessionId: "s-1",
          kind: "mcp",
          client: { name: "Agent Claude", version: "1.0" },
          approval: "always",
          clientId: "client-1",
          openedAt: "not-a-real-date",
          pendingReviews: 0,
          openTabs: 0,
        },
      ],
      clients: [
        {
          clientId: "client-1",
          name: "Agent Claude",
          enrolledAt: "not-a-real-date",
        },
      ],
    });

    await act(async () => {
      root!.render(<AgentsPanel agents={api} />);
    });
    await flush();

    const text = container?.textContent ?? "";
    expect(text).not.toContain("Invalid Date");

    const validDate = new Date("2026-10-25T14:30:45.000Z");
    expect(text).toContain(validDate.toLocaleDateString());
  });
});
