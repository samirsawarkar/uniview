import { describe, it, expect, vi } from "vitest";

// @ts-expect-error plain ESM module without types
import { AgentGrantStore } from "../../electron/lib/agent-paths.mjs";

describe("AgentGrantStore scope bounding", () => {
  // Mutation caught: closeScope() failing to delete scope entry from #scopes,
  // causing unbounded memory growth over open/close cycles
  it("leaves #scopes size bounded to 0 after 1000 open/close cycles", async () => {
    const store = new AgentGrantStore();

    for (let i = 0; i < 1000; i++) {
      const scopeId = store.openScope();
      expect(store.size).toBe(1);
      await store.closeScope(scopeId);
      expect(store.size).toBe(0);
    }

    expect(store.size).toBe(0);
    expect(store.scopeCount).toBe(0);
  });

  // Mutation caught: closeScope() deleting scope but failing to close open handles
  it("closes all handles and removes tokens when scope is closed", async () => {
    const store = new AgentGrantStore();
    const scopeId = store.openScope();

    let closed = false;
    const fakeHandle = {
      close: async () => {
        closed = true;
      },
    };

    const token = store.grant(scopeId, { handle: fakeHandle, canonical: "C:\\a.txt", size: 10 });
    expect(store.inScope(token, scopeId)).toBe(true);
    expect(store.get(token, scopeId)).toBeDefined();
    expect(store.size).toBe(1);

    await store.closeScope(scopeId);

    expect(closed).toBe(true);
    expect(store.inScope(token, scopeId)).toBe(false);
    expect(store.get(token, scopeId)).toBeUndefined();
    expect(store.size).toBe(0);

    // Idempotent close
    await store.closeScope(scopeId);
    expect(store.size).toBe(0);
  });
});
