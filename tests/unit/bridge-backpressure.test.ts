import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import crypto from "node:crypto";

// @ts-expect-error plain ESM module without types
import { startBridgeServer, createBackpressureLogger } from "../../electron/lib/bridge-server.mjs";
// @ts-expect-error plain ESM module without types
import { encodeFrame, FrameDecoder, clientHandshake, NONCE_BYTES } from "../../electron/lib/bridge-proto.mjs";

function createDuplexPair(): [Duplex, Duplex] {
  let streamA: Duplex;
  let streamB: Duplex;

  streamA = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      streamB.push(Buffer.from(chunk));
      callback();
    },
    destroy(err, callback) {
      callback(err);
      if (!streamB.destroyed) {
        streamB.destroy();
      }
    },
  });

  streamB = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      streamA.push(Buffer.from(chunk));
      callback();
    },
    destroy(err, callback) {
      callback(err);
      if (!streamA.destroyed) {
        streamA.destroy();
      }
    },
  });

  return [streamA, streamB];
}

function createMockServer() {
  const server = new EventEmitter() as any;
  server.listen = vi.fn((_endpoint: string) => {
    process.nextTick(() => server.emit("listening"));
    return server;
  });
  server.close = vi.fn((cb: () => void) => {
    if (cb) cb();
    return server;
  });
  return server;
}

describe("bridge backpressure and outbound byte bounding", () => {
  let mockServer: any;
  let bridge: any;
  const key = crypto.randomBytes(32);

  afterEach(async () => {
    if (bridge) {
      await bridge.close();
      bridge = null;
    }
    vi.restoreAllMocks();
  });

  // Mutation caught: responses written with socket.write() ignoring return value, no outbound byte tracking,
  // allowing memory to grow unbounded when client stops reading and socket never flushes.
  it("destroys connection when queued outbound bytes exceed 4 MiB with non-draining socket", async () => {
    mockServer = createMockServer();
    const backpressureSpy = vi.fn();

    bridge = await startBridgeServer({
      endpoint: "test-pipe",
      key,
      createServer: () => mockServer,
      onRequest: async (_session: any, header: any) => {
        // Return 1 MiB body for each request
        return {
          result: { handled: header.id },
          body: Buffer.alloc(1024 * 1024, 0xaa),
        };
      },
      onBackpressure: backpressureSpy,
    });

    const [serverSocket, clientSocket] = createDuplexPair();
    mockServer.emit("connection", serverSocket);

    // Complete client-side handshake
    const clientHandshakePromise = clientHandshake(clientSocket, { key });
    await clientHandshakePromise;

    // Simulate client who stops reading: serverSocket.write returns false and never calls callback
    const originalWrite = serverSocket.write.bind(serverSocket);
    let writesBlocked = true;
    serverSocket.write = vi.fn((chunk: any, cb?: any) => {
      if (writesBlocked) {
        // Return false and do not invoke callback (non-draining write)
        return false;
      }
      return originalWrite(chunk, cb);
    }) as any;

    // Send concurrent requests each producing > 1 MiB response
    // After 5 responses (> 4 MiB queued), server must destroy connection
    for (let id = 1; id <= 5; id++) {
      clientSocket.write(encodeFrame({ t: "req", id, method: "test.data" }));
    }
    // Allow microtask ticks for in-flight requests to resolve and write responses
    await new Promise((r) => setTimeout(r, 100));

    expect(serverSocket.destroyed).toBe(true);
    expect(backpressureSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "buffer_overflow" })
    );
  });

  // Mutation caught: ignoring lack of 'drain' when socket.write() returns false, never timing out hanging writes
  it("destroys connection if non-draining write persists for 10 seconds", async () => {
    vi.useFakeTimers();
    try {
      mockServer = createMockServer();
      const backpressureSpy = vi.fn();

      bridge = await startBridgeServer({
        endpoint: "test-pipe-timeout",
        key,
        createServer: () => mockServer,
        onRequest: async (_session: any, header: any) => {
          return { result: { ok: true, id: header.id } };
        },
        onBackpressure: backpressureSpy,
      });

      const [serverSocket, clientSocket] = createDuplexPair();
      mockServer.emit("connection", serverSocket);

      // Handshake with real timers or step through
      await clientHandshake(clientSocket, { key });

      // Simulate a write returning false and never draining
      serverSocket.write = vi.fn((_chunk: any, _cb?: any) => {
        return false;
      }) as any;

      clientSocket.write(encodeFrame({ t: "req", id: 99, method: "test.wait" }));
      // Let onRequest resolve
      await vi.advanceTimersByTimeAsync(50);

      expect(serverSocket.destroyed).toBe(false);

      // Advance to 9.9 seconds - should still be alive
      await vi.advanceTimersByTimeAsync(9900);
      expect(serverSocket.destroyed).toBe(false);

      // Advance past 10 seconds - must be destroyed
      await vi.advanceTimersByTimeAsync(100);
      expect(serverSocket.destroyed).toBe(true);
      expect(backpressureSpy).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "drain_timeout" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // Mutation caught: false positive backpressure destroying well-behaved draining connections
  it("normal client that flushes and drains is unaffected", async () => {
    mockServer = createMockServer();
    const backpressureSpy = vi.fn();

    bridge = await startBridgeServer({
      endpoint: "test-pipe-normal",
      key,
      createServer: () => mockServer,
      onRequest: async (_session: any, header: any) => {
        return { result: { echo: header.id } };
      },
      onBackpressure: backpressureSpy,
    });

    const [serverSocket, clientSocket] = createDuplexPair();
    mockServer.emit("connection", serverSocket);

    const clientSession = await clientHandshake(clientSocket, { key });
    const decoder = clientSession.decoder;

    const receivedResponses: any[] = [];
    clientSocket.on("data", (chunk: Buffer) => {
      const frames = decoder.push(chunk);
      for (const f of frames) {
        if (f.header.t === "res") {
          receivedResponses.push(f);
        }
      }
    });

    for (let id = 1; id <= 5; id++) {
      clientSocket.write(encodeFrame({ t: "req", id, method: "test.normal" }));
    }

    await new Promise((r) => setTimeout(r, 100));

    expect(serverSocket.destroyed).toBe(false);
    expect(receivedResponses).toHaveLength(5);
    expect(backpressureSpy).not.toHaveBeenCalled();
  });
});
