import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import path from "node:path";
import { makeTempDir } from "./agent-helpers";
// @ts-expect-error plain ESM module without types
import { startBridgeServer } from "../../electron/lib/bridge-server.mjs";
// @ts-expect-error plain ESM module without types
import { connectBridge } from "../../electron/lib/bridge-client.mjs";

// The MCP server leaves one in-flight slot free for review.cancelWait (it caps tools/call at 15 of the 16 the
// bridge allows), and the bridge itself must never answer a cancel with busy, or a cancelled wait could not be ended.

describe("bridge in-flight admission and review.cancelWait", () => {
  it("a full set of in-flight requests answers busy to the next one but still serves review.cancelWait", async () => {
    // Mutation: counting cancelWait against the in-flight limit (a wait that cannot be cancelled keeps its review slot busy)
    const dir = await makeTempDir();
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\uniview-test-${crypto.randomBytes(8).toString("hex")}` : path.join(dir, "b.sock");
    const key = crypto.randomBytes(32);
    const held: Array<() => void> = [];
    const server = await startBridgeServer({
      endpoint,
      key,
      maxInFlight: 2,
      onRequest: async (_s: unknown, header: any) => {
        if (header.method === "review.cancelWait") return { result: {} };
        await new Promise<void>((r) => held.push(r));
        return { result: { done: true } };
      },
    });
    const client = await connectBridge({ endpoint, key });
    const a = client.request("review.wait");
    const b = client.request("review.wait");
    for (let i = 0; i < 100 && held.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(held).toHaveLength(2);
    await expect(client.request("review.wait")).rejects.toMatchObject({ code: "busy" });
    await expect(client.request("review.cancelWait", { reviewId: "x" })).resolves.toMatchObject({ result: {} });
    await expect(client.request("review.cancelWait", { reviewId: "x" })).resolves.toMatchObject({ result: {} });
    held.forEach((r) => r());
    await Promise.all([a, b]);
    await client.close();
    await server.close();
  });
});
