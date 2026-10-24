import crypto from "node:crypto";
import path from "node:path";
import { createFakeClock, flush, makeTempDir } from "./agent-helpers";
// @ts-expect-error plain ESM module without types
import { createAgentHost } from "../../electron/lib/agent-host.mjs";
// @ts-expect-error plain ESM module without types
import { createEnrollmentStore } from "../../electron/lib/agent-enrollment.mjs";
// @ts-expect-error plain ESM module without types
import { createActivityLog } from "../../electron/lib/agent-activity.mjs";
// @ts-expect-error plain ESM module without types
import { createDecisionStore } from "../../electron/lib/review-store.mjs";
// @ts-expect-error plain ESM module without types
import { createVerifier } from "../../electron/lib/review-verify.mjs";

export { flush, createFakeClock };

export const sha256 = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");

/** In-memory files behind a fake path policy; counts live handles so tests can prove nothing leaks. */
export function makeFakeFs() {
  const files = new Map<string, { data: Buffer; ino: number }>();
  const refused = new Set<string>();
  let nextIno = 1;
  const state = { live: 0, opened: 0 };
  const api = {
    state,
    set(p: string, data: Buffer | string) {
      files.set(p, { data: Buffer.from(data), ino: nextIno++ });
    },
    /** Same name, new file identity (a rename-replace). */
    replace(p: string, data: Buffer | string) {
      files.set(p, { data: Buffer.from(data), ino: nextIno++ });
    },
    remove(p: string) {
      files.delete(p);
    },
    refuse(p: string) {
      refused.add(p);
    },
    async openAgentPath(p: string) {
      await Promise.resolve();
      if (refused.has(p)) return { ok: false, code: "bad_path", reason: "refused" };
      const f = files.get(p);
      if (!f) return { ok: false, code: "not_found", reason: "missing" };
      state.live++;
      state.opened++;
      let cursor = 0;
      let closed = false;
      const handle = {
        async read(buffer: Buffer, offset: number, length: number, position: number | null) {
          const from = position === null || position === undefined ? cursor : position;
          const n = Math.max(0, Math.min(length, f.data.length - from));
          f.data.copy(buffer, offset, from, from + n);
          if (position === null || position === undefined) cursor += n;
          return { bytesRead: n, buffer };
        },
        async close() {
          if (!closed) {
            closed = true;
            state.live--;
          }
        },
      };
      return { ok: true, handle, canonical: p, size: f.data.length, dev: 1n, ino: BigInt(f.ino) };
    },
  };
  return api;
}

export function makeUi() {
  const calls = { openFile: [] as any[], showView: [] as any[], showReview: [] as any[], closeTab: [] as string[] };
  const ui = {
    calls,
    failWith: null as null | { code?: string },
    async openFile(p: any) {
      if (ui.failWith) throw Object.assign(new Error("ui"), ui.failWith);
      calls.openFile.push(p);
    },
    async showView(p: any) {
      if (ui.failWith) throw Object.assign(new Error("ui"), ui.failWith);
      calls.showView.push(p);
    },
    async showReview(p: any) {
      if (ui.failWith) throw Object.assign(new Error("ui"), ui.failWith);
      calls.showReview.push(p);
    },
    async closeTab(id: string) {
      calls.closeTab.push(id);
    },
  };
  return ui;
}

export function makeDialog() {
  const calls: Array<{ sessionId: string; client: { name: string; version: string }; signal: AbortSignal; answer: (a: unknown) => void }> = [];
  const ask = (req: any) =>
    new Promise((resolve) => {
      calls.push({ ...req, answer: resolve });
    });
  /** Answers the next dialog (waiting for it to appear). */
  async function answer(a: "allow_session" | "allow_always" | "deny") {
    for (let i = 0; i < 50 && calls.length === answered.n; i++) await flush();
    calls[answered.n]!.answer(a);
    answered.n++;
  }
  const answered = { n: 0 };
  return { calls, ask, answer };
}

export type TestSession = { sessionId: string; clientNonce: Buffer; serverNonce: Buffer };
let sessionCounter = 0;
export function newSession(): TestSession {
  const n = ++sessionCounter;
  return { sessionId: n.toString(16).padStart(32, "0"), clientNonce: crypto.randomBytes(32), serverNonce: crypto.randomBytes(32) };
}

export async function makeHost() {
  const clock = createFakeClock();
  const fakeFs = makeFakeFs();
  const ui = makeUi();
  const dialog = makeDialog();
  const root = await makeTempDir("uv-host");
  const enrollment = createEnrollmentStore({ dir: path.join(root, "agents") });
  await enrollment.load();
  const activity = createActivityLog({ store: { async load() { return []; }, async save() {} }, now: clock.now });
  const store = createDecisionStore({ dir: path.join(root, "reviews") });
  const verifier = createVerifier({ openAgentPath: fakeFs.openAgentPath, now: clock.now });
  const closedSessions: string[] = [];
  const host = createAgentHost({
    openAgentPath: fakeFs.openAgentPath,
    store,
    verifier,
    enrollment,
    activity,
    ask: dialog.ask,
    ui,
    closeSession: (id: string) => closedSessions.push(id),
    clock,
  });

  const call = async (s: TestSession, method: string, params: unknown = {}, body?: Buffer): Promise<any> => {
    const res = await host.onRequest(s, { t: "req", id: 1, method, params }, body);
    return res.result;
  };
  /** The bridge error code a call fails with. */
  const fail = async (s: TestSession, method: string, params: unknown = {}, body?: Buffer): Promise<string> => {
    try {
      await call(s, method, params, body);
    } catch (e: any) {
      return e.code;
    }
    return "no error";
  };
  const open = (s: TestSession, paths: unknown) => call(s, "open", {}, Buffer.from(JSON.stringify(paths)));
  /** A CLI-like session (no hello) or an approved MCP one. */
  const mcp = async (name = "Claude Code") => {
    const s = newSession();
    await call(s, "mcp.hello", { client: { name, version: "1" }, protocolVersion: "2025-06-18" });
    return s;
  };
  const approvedMcp = async (name = "Claude Code") => {
    const s = await mcp(name);
    const first = call(s, "review.cancelWait", { reviewId: "x" });
    await first;
    // Force the approval through a harmless gated call.
    const p = fail(s, "review.get", { reviewId: "nope" });
    await dialog.answer("allow_session");
    expect(await p).toBe("not_found");
    return s;
  };

  return { host, clock, fakeFs, ui, dialog, enrollment, activity, store, closedSessions, root, call, fail, open, mcp, approvedMcp };
}

export function receiptJson(files: Array<{ path: string; sha256: string }>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    uniview: "receipt/1",
    createdAt: "2026-10-24T02:00:00.000Z",
    agent: { name: "test-agent" },
    task: "task",
    summary: "summary",
    files: files.map((f) => ({ ...f, role: "created" })),
    ...extra,
  });
}

export function specJson(body: unknown[] = [{ type: "heading", text: "Hello" }]) {
  return JSON.stringify({ uniview: "view/1", title: "T", body });
}

import { expect } from "vitest";
