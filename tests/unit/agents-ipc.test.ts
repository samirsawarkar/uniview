import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

// @ts-expect-error plain ESM module without types
import { handleAgentsList, handleAgentsRevoke, handleAgentsActivity, registerAgentsIpc } from "../../electron/lib/agents-ipc.mjs";

function makeFakeHost(overrides: Record<string, any> = {}) {
  const sessions = overrides.sessions ?? [
    {
      sessionId: "session-1",
      kind: "mcp",
      client: { name: "Agent Claude", version: "1.2.3" },
      approval: "always",
      clientId: "0123456789abcdef0123456789abcdef",
      openedAt: "2026-10-25T01:00:00.000Z",
      pendingReviews: 1,
      openTabs: 2,
    },
  ];
  const clients = overrides.clients ?? [
    {
      clientId: "0123456789abcdef0123456789abcdef",
      name: "Agent Claude",
      enrolledAt: "2026-10-25T00:30:00.000Z",
    },
  ];
  const activity = overrides.activity ?? [
    {
      at: "2026-10-25T01:05:00.000Z",
      type: "open",
      sessionId: "session-1",
      client: "Agent Claude",
      detail: "1 file(s)",
    },
  ];
  const revoked: string[] = [];

  return {
    listSessions: vi.fn(async () => sessions),
    listClients: vi.fn(async () => clients),
    listActivity: vi.fn(async () => activity),
    revokeClient: vi.fn(async (id: string) => {
      revoked.push(id);
      return { removed: true, sessionsClosed: 1 };
    }),
    revoked,
    ...overrides,
  };
}

describe("agents-ipc: handler argument validation and hostile values", () => {
  // Mutation caught: handleAgentsList accepts non-plain objects, primitive junk, or unexpected properties
  it("agents:list accepts undefined or empty object, and rejects hostile values", async () => {
    const host = makeFakeHost();

    // Valid calls
    const resEmpty = await handleAgentsList(host, {});
    expect(resEmpty.ok).toBe(true);
    expect(Array.isArray(resEmpty.sessions)).toBe(true);
    expect(Array.isArray(resEmpty.clients)).toBe(true);
    expect(Array.isArray(resEmpty.activity)).toBe(true);

    const resUndef = await handleAgentsList(host, undefined);
    expect(resUndef.ok).toBe(true);

    // Hostile values
    const hostile: unknown[] = [
      null,
      123,
      "huge string".repeat(1000),
      [1, 2, 3],
      { rogue: "property" },
      { __proto__: { hacked: true } },
      Object.create({ prototypeProp: true }),
    ];

    for (const h of hostile) {
      const res = await handleAgentsList(host, h);
      expect(res.ok).toBe(false);
      expect(res.code).toBe("bad_args");
      expect(typeof res.error).toBe("string");
    }
  });

  // Mutation caught: handleAgentsRevoke fails to validate clientId or accepts malformed / hostile inputs
  it("agents:revoke validates clientId string and rejects hostile values", async () => {
    const host = makeFakeHost();

    // Valid call
    const okRes = await handleAgentsRevoke(host, { clientId: "0123456789abcdef0123456789abcdef" });
    expect(okRes.ok).toBe(true);
    expect(okRes.removed).toBe(true);
    expect(okRes.sessionsClosed).toBe(1);
    expect(host.revoked).toContain("0123456789abcdef0123456789abcdef");

    // Hostile / invalid calls
    const badRevokes: unknown[] = [
      undefined,
      null,
      "0123456789abcdef0123456789abcdef", // primitive instead of object
      {},
      { clientId: "" },
      { clientId: null },
      { clientId: 123 },
      { clientId: ["an-array"] },
      { clientId: {} },
      { clientId: "a".repeat(100000) }, // oversized string
      { clientId: "0123456789abcdef0123456789abcdef", extra: "property" },
      { clientId: "<script>alert(1)</script>" },
      Object.create({ clientId: "0123456789abcdef0123456789abcdef" }),
    ];

    for (const bad of badRevokes) {
      const res = await handleAgentsRevoke(host, bad);
      expect(res.ok).toBe(false);
      expect(res.code).toBe("bad_args");
    }
  });

  // Mutation caught: handleAgentsActivity accepts limit > 500 or limit < 1 or non-integers
  it("agents:activity enforces exact 1..500 bounds (limit 500 OK, limit+1 501 rejected)", async () => {
    const manyEntries = Array.from({ length: 600 }, (_, i) => ({
      at: new Date(1700000000000 + i * 1000).toISOString(),
      type: "open",
      sessionId: `s-${i}`,
      client: "agent",
      detail: `file ${i}`,
    }));
    const host = makeFakeHost({ activity: manyEntries });

    // Lower bound: limit 1 OK
    const res1 = await handleAgentsActivity(host, { limit: 1 });
    expect(res1.ok).toBe(true);
    expect(res1.activity).toHaveLength(1);

    // Default or mid-range: limit 100 OK
    const res100 = await handleAgentsActivity(host, { limit: 100 });
    expect(res100.ok).toBe(true);
    expect(res100.activity).toHaveLength(100);

    // Upper bound: limit 500 OK
    const res500 = await handleAgentsActivity(host, { limit: 500 });
    expect(res500.ok).toBe(true);
    expect(res500.activity).toHaveLength(500);

    // Limit + 1: 501 rejected
    const res501 = await handleAgentsActivity(host, { limit: 501 });
    expect(res501.ok).toBe(false);
    expect(res501.code).toBe("bad_args");

    // Lower bound - 1: limit 0 rejected
    const res0 = await handleAgentsActivity(host, { limit: 0 });
    expect(res0.ok).toBe(false);
    expect(res0.code).toBe("bad_args");

    // Negative limit rejected
    const resNeg = await handleAgentsActivity(host, { limit: -5 });
    expect(resNeg.ok).toBe(false);
    expect(resNeg.code).toBe("bad_args");

    // Non-integer and junk values rejected
    for (const bad of [
      { limit: 50.5 },
      { limit: "100" },
      { limit: null },
      { limit: undefined },
      { limit: [100] },
      { limit: 100, extra: 1 },
      null,
      undefined,
      100,
    ]) {
      const res = await handleAgentsActivity(host, bad);
      expect(res.ok).toBe(false);
      expect(res.code).toBe("bad_args");
    }
  });

  // Mutation caught: agents:list returns all activity entries without capping at last 100
  it("agents:list caps activity to the last 100 entries", async () => {
    const manyEntries = Array.from({ length: 250 }, (_, i) => ({
      at: new Date(1700000000000 + i * 1000).toISOString(),
      type: "op",
      sessionId: `s-${i}`,
      client: `agent-${i}`,
      detail: `action ${i}`,
    }));
    const host = makeFakeHost({ activity: manyEntries });

    const res = await handleAgentsList(host);
    expect(res.ok).toBe(true);
    expect(res.activity).toHaveLength(100);
    // Should be the last (most recent) 100 entries: from index 150 to 249
    expect(res.activity[0].sessionId).toBe("s-150");
    expect(res.activity[99].sessionId).toBe("s-249");
  });
});

describe("agents-ipc: security and secret redaction", () => {
  // Mutation caught: agents:list or agents:activity returns secret keys, proofs, nonces or paths
  it("never returns keys, proofs, nonces or file paths in responses", async () => {
    const toxicSession = {
      sessionId: "sess-toxic",
      kind: "mcp",
      client: { name: "Agent With Secrets", version: "1.0" },
      approval: "always",
      clientId: "client-toxic",
      openedAt: "2026-10-25T01:00:00.000Z",
      pendingReviews: 0,
      openTabs: 1,
      // Injected secret fields that must never leak:
      key: "SECRET_KEY_HEX_1234567890abcdef",
      clientKey: "SECRET_CLIENT_KEY",
      proof: "SECRET_PROOF_BASE64",
      serverNonce: "SERVER_NONCE_32_BYTES",
      clientNonce: "CLIENT_NONCE_32_BYTES",
      path: "/Users/secret/file.txt",
      filePath: "C:\\Windows\\System32\\config",
    };

    const toxicClient = {
      clientId: "client-toxic",
      name: "Agent With Secrets",
      enrolledAt: "2026-10-25T00:00:00.000Z",
      key: "SECRET_KEY_HEX_IN_CLIENT",
      proof: "SECRET_PROOF_IN_CLIENT",
      keyPath: "/var/secret/client.key",
    };

    const toxicActivity = {
      at: "2026-10-25T01:01:00.000Z",
      type: "open",
      sessionId: "sess-toxic",
      client: "Agent With Secrets",
      detail: "opened 1 file",
      path: "/workspace/secret.ts",
      filePath: "I:\\Sensitive\\data.doc",
      nonce: "ACTIVITY_NONCE",
      key: "ACTIVITY_KEY",
    };

    const host = makeFakeHost({
      sessions: [toxicSession],
      clients: [toxicClient],
      activity: [toxicActivity],
    });

    const listRes = await handleAgentsList(host);
    expect(listRes.ok).toBe(true);

    const serializedList = JSON.stringify(listRes);
    expect(serializedList).not.toContain("SECRET_KEY");
    expect(serializedList).not.toContain("SECRET_CLIENT_KEY");
    expect(serializedList).not.toContain("SECRET_PROOF");
    expect(serializedList).not.toContain("SERVER_NONCE");
    expect(serializedList).not.toContain("CLIENT_NONCE");
    expect(serializedList).not.toContain("/Users/secret");
    expect(serializedList).not.toContain("System32");
    expect(serializedList).not.toContain("/var/secret");
    expect(serializedList).not.toContain("/workspace/secret.ts");
    expect(serializedList).not.toContain("Sensitive");
    expect(serializedList).not.toContain("ACTIVITY_NONCE");

    const actRes = await handleAgentsActivity(host, { limit: 10 });
    expect(actRes.ok).toBe(true);
    const serializedAct = JSON.stringify(actRes);
    expect(serializedAct).not.toContain("/workspace/secret.ts");
    expect(serializedAct).not.toContain("Sensitive");
    expect(serializedAct).not.toContain("ACTIVITY_NONCE");
    expect(serializedAct).not.toContain("ACTIVITY_KEY");
  });

  // Mutation caught: bidi or control characters not stripped from names or length uncapped
  it("sanitises bidi and control characters from untrusted labels and caps length", async () => {
    const maliciousName = "Agent\u0000\u001fEvil\u202E\u2066Name\u200E\r\n" + "x".repeat(120);
    const maliciousVersion = "v1.0\u0000\u202E" + "y".repeat(60);
    const maliciousDetail = "Detail\u0007\u202Ainfo\n" + "z".repeat(300);

    const host = makeFakeHost({
      sessions: [
        {
          sessionId: "s-bidi",
          kind: "mcp",
          client: { name: maliciousName, version: maliciousVersion },
          approval: "always",
          clientId: "c-bidi",
          openedAt: "2026-10-25T01:00:00.000Z",
          pendingReviews: 0,
        },
      ],
      clients: [
        {
          clientId: "c-bidi",
          name: maliciousName,
          enrolledAt: "2026-10-25T00:00:00.000Z",
        },
      ],
      activity: [
        {
          at: "2026-10-25T01:00:00.000Z",
          type: "open",
          sessionId: "s-bidi",
          client: maliciousName,
          detail: maliciousDetail,
        },
      ],
    });

    const res = await handleAgentsList(host);
    expect(res.ok).toBe(true);

    const session = res.sessions[0];
    expect(session.client.name).not.toMatch(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/);
    expect(session.client.name.length).toBeLessThanOrEqual(80);
    expect(session.client.version.length).toBeLessThanOrEqual(40);

    const client = res.clients[0];
    expect(client.name).not.toMatch(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/);
    expect(client.name.length).toBeLessThanOrEqual(80);

    const act = res.activity[0];
    expect(act.client).not.toMatch(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/);
    expect(act.client.length).toBeLessThanOrEqual(80);
    expect(act.detail.length).toBeLessThanOrEqual(200);
  });
});

describe("agents-ipc: registration and sender verification (fromApp fail-closed)", () => {
  function fakeIpc() {
    const handlers = new Map<string, (...a: any[]) => any>();
    return {
      handlers,
      ipcMain: {
        handle: (ch: string, fn: any) => void handlers.set(ch, fn),
      },
    };
  }

  // Mutation caught: registerAgentsIpc succeeds when fromApp is missing or invalid
  it("throws TypeError if fromApp is missing or not a function", async () => {
    const host = makeFakeHost();
    const { ipcMain, handlers } = fakeIpc();

    for (const badFromApp of [undefined, null, true, "not-a-fn", {}, 123]) {
      await expect(registerAgentsIpc({ ipcMain, fromApp: badFromApp as any, host })).rejects.toThrow(
        /fromApp/
      );
      expect(handlers.size).toBe(0);
    }
  });

  // Mutation caught: IPC handlers accept requests when fromApp returns false
  it("refuses any request when fromApp returns false, and allows when fromApp returns true", async () => {
    const host = makeFakeHost();
    const { ipcMain, handlers } = fakeIpc();
    let allowed = false;

    await registerAgentsIpc({
      ipcMain,
      fromApp: () => allowed,
      host,
    });

    expect([...handlers.keys()].sort()).toEqual(["agents:activity", "agents:list", "agents:revoke"]);

    const listHandler = handlers.get("agents:list")!;
    const revokeHandler = handlers.get("agents:revoke")!;
    const activityHandler = handlers.get("agents:activity")!;

    // When fromApp is false -> rejects
    await expect(listHandler({}, {})).rejects.toThrow(/refused/);
    await expect(revokeHandler({}, { clientId: "0123456789abcdef0123456789abcdef" })).rejects.toThrow(/refused/);
    await expect(activityHandler({}, { limit: 10 })).rejects.toThrow(/refused/);

    // When fromApp is true -> succeeds
    allowed = true;
    const resList = await listHandler({}, {});
    expect(resList.ok).toBe(true);

    const resRevoke = await revokeHandler({}, { clientId: "0123456789abcdef0123456789abcdef" });
    expect(resRevoke.ok).toBe(true);

    const resAct = await activityHandler({}, { limit: 10 });
    expect(resAct.ok).toBe(true);
  });

  // Mutation caught: unexpected host errors leak internal exceptions or stack traces
  it("catches unexpected exceptions and returns fixed error without leaking internals", async () => {
    const host = {
      listSessions: async () => {
        throw new Error("SECRET_DATABASE_EXCEPTION at C:\\internal\\host.mjs:42");
      },
      listClients: async () => [],
      listActivity: async () => [],
      revokeClient: async () => ({ removed: false }),
    };

    const { ipcMain, handlers } = fakeIpc();
    await registerAgentsIpc({
      ipcMain,
      fromApp: () => true,
      host,
    });

    const res = await handlers.get("agents:list")!({}, {});
    expect(res.ok).toBe(false);
    expect(res.code).toBe("failed");
    expect(JSON.stringify(res)).not.toContain("SECRET_DATABASE_EXCEPTION");
    expect(JSON.stringify(res)).not.toContain("C:\\internal");
  });
});

describe("agents-ipc: preload bridge exposure", () => {
  async function loadPreload() {
    const preloadPath = path.resolve(__dirname, "../../electron/preload.cjs");
    const src = await fs.readFile(preloadPath, "utf8");
    const calls: any[][] = [];
    let exposed: any;

    const fakeElectron = {
      contextBridge: { exposeInMainWorld: (_n: string, api: any) => (exposed = api) },
      ipcRenderer: {
        on() {},
        send() {},
        invoke: (...a: any[]) => {
          calls.push(a);
          return Promise.resolve({ ok: true });
        },
      },
      webUtils: {},
    };

    new Function("require", src)(() => fakeElectron);
    return { agents: exposed?.agents, calls };
  }

  // Mutation caught: preload exposes extra methods or forwards unvalidated arguments
  it("preload exposes only list, revoke, activity and normalizes arguments", async () => {
    const { agents, calls } = await loadPreload();
    expect(agents).toBeDefined();
    expect(Object.keys(agents).sort()).toEqual(["activity", "list", "revoke"]);

    // Test list
    await agents.list();
    expect(calls.at(-1)).toEqual(["agents:list"]);

    // Test revoke
    await agents.revoke("client-xyz");
    expect(calls.at(-1)).toEqual(["agents:revoke", { clientId: "client-xyz" }]);

    await agents.revoke({ clientId: "client-abc" });
    expect(calls.at(-1)).toEqual(["agents:revoke", { clientId: "client-abc" }]);

    // Test activity
    await agents.activity(50);
    expect(calls.at(-1)).toEqual(["agents:activity", { limit: 50 }]);

    await agents.activity();
    expect(calls.at(-1)).toEqual(["agents:activity", { limit: 100 }]);
  });
});
