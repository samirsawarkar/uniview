import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
// @ts-expect-error plain ESM module without types
import { ensureBridgeDir, ensureBridgeKey, ensureInstallId, windowsUserSid, bridgeEndpoint } from "../../electron/lib/bridge-key.mjs";
// @ts-expect-error plain ESM module without types
import { startBridgeServer } from "../../electron/lib/bridge-server.mjs";
// @ts-expect-error plain ESM module without types
import { BridgeError } from "../../electron/lib/bridge-proto.mjs";

// Process-level CLI tests (the cli.e2e row of the behaviour-to-test map, without Electron): the real CLI entry
// (scripts/cli-runner.mjs -> electron/lib/cli.mjs -> bridge-client.mjs) runs as a separate node process against a
// real bridge-server.mjs on a real named pipe / Unix socket, with a real key in a temp userData folder.
// Electron itself is not needed: bridge-key/-server/-client/-proto and cli are plain node modules. What is NOT
// covered here is app launching (cold start through electron/main.mjs), which is the wiring packet's job.

const runner = path.resolve(__dirname, "../../scripts/cli-runner.mjs");
const KILL_AFTER_MS = 20000;

type Req = { method: string; params: any; paths?: string[] };
type ChildResult = { code: number | null; stdout: string; stderr: string; exitedAt: number };

async function makeDir(): Promise<string> {
  const base = process.platform === "win32" ? "I:\\AES\\tmp" : path.join(os.tmpdir(), "aes-test");
  const dir = path.join(base, `uv-cli-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Real bridge server with stub `open` / `view.show` / `review.open` / `review.wait` handlers; reviews are decided by the test. */
async function startStub() {
  const work = await makeDir();
  const userData = path.join(work, "userData");
  await fs.mkdir(userData);
  const bridgeDir = await ensureBridgeDir(userData);
  const key = await ensureBridgeKey(bridgeDir);
  const installId = await ensureInstallId(bridgeDir);
  const endpoint =
    process.platform === "win32"
      ? bridgeEndpoint({ bridgeDir, userSid: await windowsUserSid(), installId })
      : bridgeEndpoint({ bridgeDir });

  const requests: Req[] = [];
  const waiting = new Map<string, (decision: unknown) => void>();
  let nextReview = 0;
  const failPath = { value: "" };

  const server = await startBridgeServer({
    endpoint,
    key,
    onRequest: async (_session: unknown, header: any, body?: Buffer) => {
      const paths: string[] | undefined = body && body.length > 0 ? JSON.parse(body.toString("utf8")) : undefined;
      requests.push({ method: header.method, params: header.params, ...(paths ? { paths } : {}) });
      const refused = (p: string) => failPath.value !== "" && p.endsWith(failPath.value);
      if (header.method === "cli.hello") {
        return { result: { version: "1" } };
      }
      if (header.method === "open") {
        if (refused(paths![0]!)) throw new BridgeError("bad_path");
        return { result: { opened: 1 } };
      }
      if (header.method === "view.show") {
        if (refused(header.params.path)) throw new BridgeError("invalid_spec");
        return { result: { scopeId: "scope-1" } };
      }
      if (header.method === "review.open") {
        if (refused(header.params.path)) throw new BridgeError("invalid_receipt");
        return { result: { reviewId: `review-${++nextReview}` } };
      }
      if (header.method === "review.wait") {
        const id = header.params.reviewId as string;
        return new Promise((resolve) => waiting.set(id, (decision) => resolve({ result: { status: "decided", decision } })));
      }
      throw new BridgeError("unknown_method");
    },
  });
  let closed = false;
  const closeServer = async () => {
    if (closed) return;
    closed = true;
    await server.close();
  };
  cleanups.push(async () => {
    await closeServer();
    await fs.rm(work, { recursive: true, force: true });
  });

  return {
    work,
    userData,
    requests,
    failPath,
    closeServer,
    /** Resolves when the server has received wait_review for this review. */
    waitingFor: async (id: string) => {
      for (let i = 0; i < 200 && !waiting.has(id); i++) await new Promise((r) => setTimeout(r, 25));
      if (!waiting.has(id)) throw new Error(`no wait_review for ${id}`);
    },
    decide: (id: string, kind: string) =>
      waiting.get(id)!({ uniview: "decision/1", reviewId: id, decision: kind, comment: "", persisted: true, files: [] }),
  };
}

function runCliProcess(args: string[], opts: { cwd: string; userData: string }) {
  const child = spawn(process.execPath, [runner, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, UNIVIEW_USER_DATA: opts.userData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const killer = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);
  const result = new Promise<ChildResult>((resolve) => {
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr, exitedAt: Date.now() });
    });
  });
  return { child, result };
}

describe("cli process (real CLI process, real bridge server and key)", () => {
  it("open: hands the absolute path to the app, prints one line, exit 0, process ends by itself", async () => {
    // Mutation: relative paths sent, ack missing, non-zero exit, or a socket/timer left open so the process never ends (killed -> code null)
    const stub = await startStub();
    const { result } = runCliProcess(["open", "a.txt"], { cwd: stub.work, userData: stub.userData });
    const r = await result;
    expect(r.code).toBe(0);
    const abs = path.join(stub.work, "a.txt");
    expect(r.stdout).toBe(`Opened in UniView: ${abs}\n`);
    expect(r.stderr).toBe("");
    expect(stub.requests).toEqual([
      { method: "cli.hello", params: { version: "1" } },
      { method: "open", params: {}, paths: [abs] },
    ]);
  }, 30000);

  it("usage error: exit 2, usage line, no request reaches the app", async () => {
    // Mutation: connecting before validating arguments, or exiting 1
    const stub = await startStub();
    const { result } = runCliProcess(["open", "--wait", "a.txt"], { cwd: stub.work, userData: stub.userData });
    const r = await result;
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--wait requires --receipt/);
    expect(r.stderr).toMatch(/Usage: UniView open/);
    expect(r.stdout).toBe("");
    expect(stub.requests).toEqual([]);
  }, 30000);

  it("a file the app refuses: opened ones on stdout, the failure on stderr, exit 2", async () => {
    // Mutation: exit 0 on a partial failure
    const stub = await startStub();
    stub.failPath.value = "bad.txt";
    const { result } = runCliProcess(["open", "good.txt", "bad.txt"], { cwd: stub.work, userData: stub.userData });
    const r = await result;
    expect(r.code).toBe(2);
    expect(r.stdout).toBe(`Opened in UniView: ${path.join(stub.work, "good.txt")}\n`);
    expect(r.stderr).toBe(`UniView: cannot open ${path.join(stub.work, "bad.txt")}: bad_path\n`);
  }, 30000);

  it("no app listening (no bridge key / endpoint): exit 6 without hanging", async () => {
    // Mutation: retrying forever or exiting with another code when the app cannot be reached or started
    const work = await makeDir();
    cleanups.push(() => fs.rm(work, { recursive: true, force: true }));
    const t0 = Date.now();
    const { result } = runCliProcess(["open", "a.txt"], { cwd: work, userData: path.join(work, "no-such-userdata") });
    const r = await result;
    expect(r.code).toBe(6);
    expect(r.stderr).toMatch(/^UniView: could not start the app \(Error\)\n$/);
    expect(r.stdout).toBe("");
    expect(Date.now() - t0).toBeLessThan(KILL_AFTER_MS);
  }, 30000);

  it("--wait: each decision prints its JSON and maps to 0 / 3 / 4, and the process exits promptly afterwards", async () => {
    // Mutation: wrong exit per decision, decision JSON missing, or the 3600 s timeout timer / socket left alive so the process lingers
    const stub = await startStub();
    const expected: [string, number][] = [["approved", 0], ["changes_requested", 3], ["dismissed", 4]];
    for (const [i, [kind, code]] of expected.entries()) {
      const { result } = runCliProcess(["open", "--wait", "--receipt", "r.receipt.json"], { cwd: stub.work, userData: stub.userData });
      const id = `review-${i + 1}`;
      await stub.waitingFor(id);
      const decidedAt = Date.now();
      stub.decide(id, kind);
      const r = await result;
      expect(r.code).toBe(code);
      expect(JSON.parse(r.stdout)).toMatchObject({ uniview: "decision/1", reviewId: id, decision: kind });
      expect(r.stderr).toBe(`Opened in UniView: ${path.join(stub.work, "r.receipt.json")}; waiting for the review decision\n`);
      expect(r.exitedAt - decidedAt).toBeLessThan(3000);
    }
    expect(stub.requests.map((q) => q.method)).toEqual([
      "cli.hello", "review.open", "review.wait",
      "cli.hello", "review.open", "review.wait",
      "cli.hello", "review.open", "review.wait",
    ]);
  }, 60000);

  it("two simultaneous --wait processes each get their own decision", async () => {
    // Mutation: sharing a review between clients (e.g. a fixed reviewId)
    const stub = await startStub();
    const a = runCliProcess(["open", "--wait", "--receipt", "a.json"], { cwd: stub.work, userData: stub.userData });
    await stub.waitingFor("review-1");
    const b = runCliProcess(["open", "--wait", "--receipt", "b.json"], { cwd: stub.work, userData: stub.userData });
    await stub.waitingFor("review-2");
    stub.decide("review-2", "changes_requested");
    stub.decide("review-1", "approved");
    const [ra, rb] = await Promise.all([a.result, b.result]);
    expect([ra.code, JSON.parse(ra.stdout).reviewId]).toEqual([0, "review-1"]);
    expect([rb.code, JSON.parse(rb.stdout).reviewId]).toEqual([3, "review-2"]);
  }, 60000);

  it("the app going away while --wait is pending: exit 6", async () => {
    // Mutation: reporting a closed connection as a timeout or a decision, or hanging
    const stub = await startStub();
    const { result } = runCliProcess(["open", "--wait", "--receipt", "r.json"], { cwd: stub.work, userData: stub.userData });
    await stub.waitingFor("review-1");
    await stub.closeServer();
    const r = await result;
    expect(r.code).toBe(6);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/the app is not reachable \(closed\)\n$/);
  }, 30000);
});
