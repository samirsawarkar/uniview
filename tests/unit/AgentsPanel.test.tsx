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
      enrolledClients: clients,
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
        enrolledClients: clientsList,
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

  // Mutation caught: activity refresh button does not trigger data re-fetch
  it("activity refresh button re-fetches activity log", async () => {
    const api = createMockAgentsApi();

    await act(async () => {
      root!.render(<AgentsPanel agents={api} />);
    });
    await flush();

    expect(api.list).toHaveBeenCalledTimes(1);

    const refreshBtn = container?.querySelector("[data-testid='refresh-activity']") as HTMLButtonElement;
    expect(refreshBtn).not.toBeNull();

    await act(async () => {
      refreshBtn.click();
    });
    await flush();

    expect(api.list).toHaveBeenCalledTimes(2);
  });
});
