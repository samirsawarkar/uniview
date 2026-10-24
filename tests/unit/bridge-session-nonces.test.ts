import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import path from "node:path";
import { makeTempDir } from "./agent-helpers";
// @ts-expect-error plain ESM module without types
import { enrollProof } from "../../electron/lib/bridge-proto.mjs";
// @ts-expect-error plain ESM module without types
import { startBridgeServer } from "../../electron/lib/bridge-server.mjs";
// @ts-expect-error plain ESM module without types
import { connectBridge } from "../../electron/lib/bridge-client.mjs";

// The enroll proof of an "Always allow" client is bound to its connection's handshake nonces, so both ends of a
// real connection (real pipe / socket) must be able to see them: the server in the session passed to onRequest
// and onSessionClosed, the client on the object connectBridge returns.

function endpointIn(dir: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\uniview-test-${crypto.randomBytes(8).toString("hex")}` : path.join(dir, "b.sock");
}

describe("bridge session nonces", () => {
  it("server session and client see the same two 32-byte nonces, so both compute the same enrollProof", async () => {
    // Mutation: not passing the nonces on (the host could never verify an enrolled client), or passing the wrong pair
    const dir = await makeTempDir();
    const endpoint = endpointIn(dir);
    const key = crypto.randomBytes(32);
    const seen: any[] = [];
    let closed!: (id: string) => void;
    const closedId = new Promise<string>((r) => (closed = r));
    const server = await startBridgeServer({
      endpoint,
      key,
      onRequest: async (session: any) => {
        seen.push(session);
        return { result: {} };
      },
      onSessionClosed: (id: string) => closed(id),
    });
    const client = await connectBridge({ endpoint, key });
    await client.request("ping");
    const session = seen[0];
    expect(session.sessionId).toBe(client.sessionId);
    expect(Buffer.isBuffer(session.clientNonce) && session.clientNonce.length === 32).toBe(true);
    expect(Buffer.isBuffer(session.serverNonce) && session.serverNonce.length === 32).toBe(true);
    expect(session.clientNonce.equals(client.clientNonce)).toBe(true);
    expect(session.serverNonce.equals(client.serverNonce)).toBe(true);
    expect(session.clientNonce.equals(session.serverNonce)).toBe(false);
    const clientKey = crypto.randomBytes(32);
    expect(enrollProof(clientKey, session.serverNonce, session.clientNonce).equals(enrollProof(clientKey, client.serverNonce, client.clientNonce))).toBe(true);
    await client.close();
    await server.close();
    expect(await closedId).toBe(client.sessionId);
  });

  it("two connections get different nonces", async () => {
    // Mutation: reusing one nonce pair for every session (a proof would be replayable across connections)
    const dir = await makeTempDir();
    const endpoint = endpointIn(dir);
    const key = crypto.randomBytes(32);
    const server = await startBridgeServer({ endpoint, key, onRequest: async () => ({ result: {} }) });
    const a = await connectBridge({ endpoint, key });
    const b = await connectBridge({ endpoint, key });
    expect(a.serverNonce.equals(b.serverNonce)).toBe(false);
    expect(a.clientNonce.equals(b.clientNonce)).toBe(false);
    await a.close();
    await b.close();
    await server.close();
  });
});
