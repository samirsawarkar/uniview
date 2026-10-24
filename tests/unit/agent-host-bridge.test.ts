import { describe, it, expect, afterEach } from "vitest";
import crypto from "node:crypto";
import path from "node:path";
import { makeHost, receiptJson, sha256 } from "./agent-host-helpers";
import { makeTempDir } from "./agent-helpers";
import { startServer, toolCall } from "./mcp-helpers";
// @ts-expect-error plain ESM module without types
import { startBridgeServer } from "../../electron/lib/bridge-server.mjs";
// @ts-expect-error plain ESM module without types
import { connectBridge } from "../../electron/lib/bridge-client.mjs";
// @ts-expect-error plain ESM module without types
import { runCli, EXIT } from "../../electron/lib/cli.mjs";
// @ts-expect-error plain ESM module without types
import { enrollProof } from "../../electron/lib/bridge-proto.mjs";
// @ts-expect-error plain ESM module without types
import { readClientKey } from "../../electron/lib/agent-enrollment.mjs";

// The CLI client and the MCP server both talk to the real agent host through a real bridge server and client
// (named pipe / Unix socket): one canonical op set, request and response shapes that fit on both sides.
// Only the file system behind the path policy, the dialog and the UI are fakes.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const abs = (p: string) => path.resolve(p);

async function rig() {
  const t = await makeHost();
  const dir = await makeTempDir("uv-hostbridge");
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\uniview-test-${crypto.randomBytes(8).toString("hex")}` : path.join(dir, "b.sock");
  const key = crypto.randomBytes(32);
  const server = await startBridgeServer({ endpoint, key, onRequest: t.host.onRequest, onSessionClosed: t.host.onSessionClosed });
  cleanups.push(() => server.close());
  const connect = () => connectBridge({ endpoint, key });
  return { t, endpoint, key, connect, dir };
}

function out() {
  let text = "";
  return { write: (s: string) => ((text += s), true), text: () => text };
}

function runTheCli(r: Awaited<ReturnType<typeof rig>>, argv: string[], sleep?: (ms: number, signal?: AbortSignal) => Promise<void>) {
  const stdout = out();
  const stderr = out();
  const done: Promise<number> = runCli({ argv, cwd: process.cwd(), stdout, stderr, connect: r.connect, startApp: async () => {}, ...(sleep ? { sleep } : {}) });
  return { stdout, stderr, done };
}

async function until<T>(fn: () => T | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("CLI against the real agent host", () => {
  it("open a b: both files become tabs; exit 0, one acknowledgement, no approval dialog", async () => {
    // Mutation: a CLI op the host does not answer, or approval applied to the CLI
    const r = await rig();
    r.t.fakeFs.set(abs("a.txt"), "a");
    r.t.fakeFs.set(abs("b.txt"), "bb");
    const cli = runTheCli(r, ["open", "a.txt", "b.txt"]);
    expect(await cli.done).toBe(EXIT.OK);
    expect(cli.stdout.text()).toBe(`Opened in UniView: ${abs("a.txt")}, ${abs("b.txt")}\n`);
    expect(r.t.ui.calls.openFile.map((c: any) => c.name)).toEqual(["a.txt", "b.txt"]);
    expect(r.t.dialog.calls).toHaveLength(0);
  });

  it("a file the path policy refuses: the others open, the refusal is named, exit 2", async () => {
    // Mutation: bridge error codes the CLI does not map (exit 6 instead of 2)
    const r = await rig();
    r.t.fakeFs.set(abs("good.txt"), "g");
    const cli = runTheCli(r, ["open", "good.txt", "missing.txt"]);
    expect(await cli.done).toBe(EXIT.USAGE);
    expect(cli.stdout.text()).toBe(`Opened in UniView: ${abs("good.txt")}\n`);
    expect(cli.stderr.text()).toBe(`UniView: cannot open ${abs("missing.txt")}: bad_path\n`);
  });

  it("--view with a bad spec: invalid_spec, exit 2", async () => {
    // Mutation: the host answering a spec problem with a code the CLI treats as app failure
    const r = await rig();
    r.t.fakeFs.set(abs("v.uview.json"), "{not json");
    const cli = runTheCli(r, ["open", "--view", "v.uview.json"]);
    expect(await cli.done).toBe(EXIT.USAGE);
    expect(cli.stderr.text()).toBe(`UniView: cannot open ${abs("v.uview.json")}: invalid_spec\n`);
  });

  for (const [kind, exit] of [["approved", EXIT.OK], ["changes_requested", EXIT.CHANGES_REQUESTED], ["dismissed", EXIT.DISMISSED]] as const) {
    it(`--wait: the person's ${kind} decision reaches the CLI as exit ${exit} with the decision JSON`, async () => {
      // Mutation: any mismatch of review.open / review.wait shapes between CLI and host
      const r = await rig();
      r.t.fakeFs.set(abs("f.txt"), "content");
      r.t.fakeFs.set(abs("r.receipt.json"), receiptJson([{ path: abs("f.txt"), sha256: sha256("content") }]));
      const cli = runTheCli(r, ["open", "--wait", "--receipt", "r.receipt.json"]);
      const shown = await until(() => r.t.ui.calls.showReview[0], "the review tab");
      if (kind === "dismissed") {
        await r.t.host.tabClosed(shown.scopeId);
      } else {
        await r.t.host.verifyReview(shown.reviewId);
        expect((await r.t.host.decideReview({ reviewId: shown.reviewId, decision: kind, comment: "because" })).ok).toBe(true);
      }
      expect(await cli.done).toBe(exit);
      const decision = JSON.parse(cli.stdout.text());
      expect(decision).toMatchObject({ uniview: "decision/1", reviewId: shown.reviewId, decision: kind });
    });
  }

  it("--wait: the app's own timeout (pending) ends the CLI with exit 5 and the review stays open", async () => {
    // Mutation: pending treated as a decision or as an app failure
    const r = await rig();
    r.t.fakeFs.set(abs("f.txt"), "content");
    r.t.fakeFs.set(abs("r.receipt.json"), receiptJson([{ path: abs("f.txt"), sha256: sha256("content") }]));
    const never = (_ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    const cli = runTheCli(r, ["open", "--wait", "--timeout", "30", "--receipt", "r.receipt.json"], never);
    const shown = await until(() => r.t.ui.calls.showReview[0], "the review tab");
    await until(() => r.t.clock.pending() > 0, "the host's wait timer");
    await r.t.clock.advance(30_000);
    expect(await cli.done).toBe(EXIT.TIMEOUT);
    expect(r.t.host.getReview(shown.reviewId)).toMatchObject({ decision: null });
  });

  it("two simultaneous --wait clients each get their own decision and cannot see each other's review", async () => {
    // Mutation: reviews shared between connections
    const r = await rig();
    r.t.fakeFs.set(abs("f.txt"), "content");
    for (const n of ["a", "b"]) r.t.fakeFs.set(abs(`${n}.receipt.json`), receiptJson([{ path: abs("f.txt"), sha256: sha256("content") }], { task: `task ${n}` }));
    const a = runTheCli(r, ["open", "--wait", "--receipt", "a.receipt.json"]);
    const b = runTheCli(r, ["open", "--wait", "--receipt", "b.receipt.json"]);
    await until(() => r.t.ui.calls.showReview.length === 2, "both reviews");
    const byTask = (task: string) => r.t.ui.calls.showReview.find((c: any) => c.receipt.task === task);
    for (const [task, decision] of [["task b", "changes_requested"], ["task a", "approved"]] as const) {
      const shown = byTask(task);
      await r.t.host.verifyReview(shown.reviewId);
      await r.t.host.decideReview({ reviewId: shown.reviewId, decision });
    }
    expect(await a.done).toBe(EXIT.OK);
    expect(await b.done).toBe(EXIT.CHANGES_REQUESTED);
    expect(JSON.parse(a.stdout.text()).reviewId).toBe(byTask("task a").reviewId);
    expect(JSON.parse(b.stdout.text()).reviewId).toBe(byTask("task b").reviewId);
  });
});

describe("MCP server against the real agent host", () => {
  function mcpRig(r: Awaited<ReturnType<typeof rig>>, connect = r.connect) {
    const s = startServer({ connect });
    cleanups.push(async () => {
      s.stdin.end();
      await s.done;
    });
    return s;
  }
  const structured = (msg: any) => msg.result.structuredContent;

  it("open_files is held until the person answers the dialog; after 'Allow for this session' it opens the tab and returns {opened}", async () => {
    // Mutation: serving before consent, or a result shape the MCP server rejects
    const r = await rig();
    r.t.fakeFs.set(abs("a.txt"), "a");
    const s = mcpRig(r);
    await s.initialize();
    s.send(toolCall(1, "open_files", { paths: [abs("a.txt")] }));
    await r.t.dialog.answer("allow_session");
    const msg = await s.nextJson();
    expect(msg.id).toBe(1);
    expect(structured(msg)).toEqual({ opened: 1 });
    expect(r.t.dialog.calls[0]!.client).toEqual({ name: "test-agent", version: "1" });
    expect(r.t.ui.calls.openFile).toHaveLength(1);
  });

  it("Don't allow: the tool call fails with not_allowed and nothing opens", async () => {
    // Mutation: a denial that still serves the call
    const r = await rig();
    r.t.fakeFs.set(abs("a.txt"), "a");
    const s = mcpRig(r);
    await s.initialize();
    s.send(toolCall(1, "open_files", { paths: [abs("a.txt")] }));
    await r.t.dialog.answer("deny");
    const msg = await s.nextJson();
    expect(msg.result.isError).toBe(true);
    expect(msg.result.structuredContent.code).toBe("not_allowed");
    expect(r.t.ui.calls.openFile).toEqual([]);
  });

  it("show_view (inline and by path) and a refused path map to the tool codes", async () => {
    // Mutation: scopeId missing from the answer, or path errors not reaching the agent as bad_path / invalid_spec
    const r = await rig();
    const s = mcpRig(r);
    await s.initialize();
    const spec = JSON.stringify({ uniview: "view/1", title: "T", body: [{ type: "heading", text: "H" }] });
    r.t.fakeFs.set(abs("v.uview.json"), spec);
    s.send(toolCall(1, "show_view", { specText: spec }));
    await r.t.dialog.answer("allow_session");
    expect(structured(await s.nextJson())).toMatchObject({ shown: true, scopeId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    s.send(toolCall(2, "show_view", { specPath: abs("v.uview.json") }));
    expect(structured(await s.nextJson()).shown).toBe(true);
    s.send(toolCall(3, "show_view", { specPath: abs("missing.uview.json") }));
    expect((await s.nextJson()).result.structuredContent.code).toBe("bad_path");
    r.t.fakeFs.set(abs("bad.uview.json"), "{nope");
    s.send(toolCall(4, "show_view", { specPath: abs("bad.uview.json") }));
    expect((await s.nextJson()).result.structuredContent.code).toBe("invalid_spec");
  });

  it("request_review with waitSeconds returns the decision; get_review is own-session only", async () => {
    // Mutation: wait/get shapes that disagree, or a review visible to another agent
    const r = await rig();
    r.t.fakeFs.set(abs("f.txt"), "content");
    const receipt = receiptJson([{ path: abs("f.txt"), sha256: sha256("content") }]);
    const a = mcpRig(r);
    const b = mcpRig(r);
    await a.initialize();
    await b.initialize();
    a.send(toolCall(1, "request_review", { receiptText: receipt, waitSeconds: 60 }));
    await r.t.dialog.answer("allow_session");
    const shown = await until(() => r.t.ui.calls.showReview[0], "the review tab");
    await r.t.host.verifyReview(shown.reviewId);
    await r.t.host.decideReview({ reviewId: shown.reviewId, decision: "approved", comment: "fine" });
    const msg = await a.nextJson();
    expect(structured(msg)).toMatchObject({ status: "decided", reviewId: shown.reviewId, decision: { decision: "approved", comment: "fine" } });
    a.send(toolCall(2, "get_review", { reviewId: shown.reviewId }));
    expect(structured(await a.nextJson()).status).toBe("decided");
    b.send(toolCall(1, "get_review", { reviewId: shown.reviewId }));
    await r.t.dialog.answer("allow_session");
    const other = await b.nextJson();
    expect(other.result.isError).toBe(true);
    expect(other.result.structuredContent.code).toBe("not_found");
  });

  it("waitSeconds 0 returns pending at once; a cancelled request_review ends the wait on the app and leaves the review open", async () => {
    // Mutation: review.cancelWait not understood by the host, or cancel closing the review
    const r = await rig();
    r.t.fakeFs.set(abs("f.txt"), "content");
    const receipt = receiptJson([{ path: abs("f.txt"), sha256: sha256("content") }]);
    const s = mcpRig(r);
    await s.initialize();
    s.send(toolCall(1, "request_review", { receiptText: receipt }));
    await r.t.dialog.answer("allow_session");
    const pending = structured(await s.nextJson());
    expect(pending).toMatchObject({ status: "pending", reviewId: expect.any(String) });
    s.send(toolCall(2, "request_review", { receiptText: receipt, waitSeconds: 600 }));
    await until(() => r.t.clock.pending() > 0, "the host's wait timer");
    s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
    await until(() => r.t.clock.pending() === 0, "the wait to be cancelled");
    expect(r.t.ui.calls.showReview).toHaveLength(2);
    expect(r.t.host.getReview(r.t.ui.calls.showReview[1].reviewId)).toMatchObject({ decision: null });
  });

  it("an enrolled agent: 'Always allow' once; the next MCP process proves itself in mcp.hello and is not asked (what the wiring packet must do)", async () => {
    // Mutation: any break in the key file / nonce / hello.enroll contract between the MCP side and the host
    const r = await rig();
    r.t.fakeFs.set(abs("a.txt"), "a");
    const first = mcpRig(r);
    await first.initialize();
    first.send(toolCall(1, "open_files", { paths: [abs("a.txt")] }));
    await r.t.dialog.answer("allow_always");
    expect(structured(await first.nextJson())).toEqual({ opened: 1 });
    expect(r.t.host.listClients().map((c: any) => c.name)).toEqual(["test-agent"]);

    // The wiring packet's connect(): read the key file by the agent's name, add enroll to mcp.hello.
    const enrollingConnect = async () => {
      const bridge = await r.connect();
      return {
        ...bridge,
        request: async (method: string, params: any, body?: Buffer) => {
          if (method !== "mcp.hello") return bridge.request(method, params, body);
          const found = await readClientKey({ dir: path.join(r.t.root, "agents"), name: params.client.name });
          const enroll = found
            ? { clientId: found.clientId, proof: enrollProof(found.key, bridge.serverNonce, bridge.clientNonce).toString("base64") }
            : undefined;
          return bridge.request(method, { ...params, ...(enroll ? { enroll } : {}) }, body);
        },
      };
    };
    const second = mcpRig(r, enrollingConnect);
    await second.initialize();
    second.send(toolCall(1, "open_files", { paths: [abs("a.txt")] }));
    expect(structured(await second.nextJson())).toEqual({ opened: 1 });
    expect(r.t.dialog.calls).toHaveLength(1);
    expect(r.t.host.listSessions().filter((x: any) => x.approval === "always")).toHaveLength(2);

    // Revoked in the Agents panel: the next process is refused outright with not_allowed (stale key file).
    const clientId = r.t.host.listClients()[0].clientId;
    await r.t.host.revokeClient(clientId);
    const keyFile = path.join(r.t.root, "agents", `${clientId}.key`);
    const fs = await import("node:fs/promises");
    await fs.writeFile(keyFile, "0".repeat(64));
    const third = mcpRig(r, enrollingConnect);
    await third.initialize();
    third.send(toolCall(1, "open_files", { paths: [abs("a.txt")] }));
    const refused = await third.nextJson();
    expect(refused.result.structuredContent.code).toBe("not_allowed");
    expect(r.t.dialog.calls).toHaveLength(1);
  });
});
