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

  // Mutation caught: terminal error branches bypassing bounded writer and drain deadline
  it("terminal error from invalid request header routes through bounded writer and destroys non-draining client within deadline", async () => {
    vi.useFakeTimers();
    try {
      mockServer = createMockServer();
      const backpressureSpy = vi.fn();

      bridge = await startBridgeServer({
        endpoint: "test-pipe-invalid-header-drain-timeout",
        key,
        createServer: () => mockServer,
        onRequest: async () => ({ result: { ok: true } }),
        onBackpressure: backpressureSpy,
      });

      const [serverSocket, clientSocket] = createDuplexPair();
      mockServer.emit("connection", serverSocket);
      await clientHandshake(clientSocket, { key });

      let writtenBytes = 0;
      serverSocket.write = vi.fn((chunk: any, _cb?: any) => {
        writtenBytes += chunk?.length ?? chunk?.byteLength ?? 0;
        // Non-draining client: write returns false and callback never fires
        return false;
      }) as any;

      // Send frame with invalid header: header.t is not "req"
      clientSocket.write(encodeFrame({ t: "not_a_req" as any }));
      await vi.advanceTimersByTimeAsync(50);

      // Verify serverSocket.write was called through the bounded writer with the error frame
      expect(serverSocket.write).toHaveBeenCalled();
      expect(writtenBytes).toBeGreaterThan(0);
      expect(serverSocket.destroyed).toBe(false);

      // Advance to 9.9s: still alive within deadline
      await vi.advanceTimersByTimeAsync(9900);
      expect(serverSocket.destroyed).toBe(false);

      // Advance past 10s: deadline exceeded, destroyed with drain_timeout
      await vi.advanceTimersByTimeAsync(100);
      expect(serverSocket.destroyed).toBe(true);
      expect(backpressureSpy).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "drain_timeout" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // Mutation caught: terminal error from decoder exception (malformed frame / bad lengths)
  // reverting catch branch to socket.end(errorFrame) instead of writeFrame({ terminal: true }),
  // bypassing bounded writer and drain deadline.
  it("terminal error from decoder exception routes through bounded writer and destroys non-draining client within deadline", async () => {
    vi.useFakeTimers();
    try {
      mockServer = createMockServer();
      const backpressureSpy = vi.fn();

      bridge = await startBridgeServer({
        endpoint: "test-pipe-decoder-exception-drain-timeout",
        key,
        createServer: () => mockServer,
        onRequest: async () => ({ result: { ok: true } }),
        onBackpressure: backpressureSpy,
      });

      const [serverSocket, clientSocket] = createDuplexPair();
      mockServer.emit("connection", serverSocket);
      await clientHandshake(clientSocket, { key });

      let writtenBytes = 0;
      serverSocket.write = vi.fn((chunk: any, _cb?: any) => {
        writtenBytes += chunk?.length ?? chunk?.byteLength ?? 0;
        // Non-draining client: write returns false and callback never fires
        return false;
      }) as any;

      // Send malformed frame header that causes decoder exception (bad JSON)
      const malformedHeader = Buffer.from("not-valid-json");
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(malformedHeader.length, 0);
      clientSocket.write(Buffer.concat([lenBuf, malformedHeader]));
      await vi.advanceTimersByTimeAsync(50);

      // Verify serverSocket.write was called through the bounded writer with the error frame
      expect(serverSocket.write).toHaveBeenCalled();
      expect(writtenBytes).toBeGreaterThan(0);
      expect(serverSocket.destroyed).toBe(false);

      // Advance to 9.9s: still alive within deadline
      await vi.advanceTimersByTimeAsync(9900);
      expect(serverSocket.destroyed).toBe(false);

      // Advance past 10s: deadline exceeded, destroyed with drain_timeout
      await vi.advanceTimersByTimeAsync(100);
      expect(serverSocket.destroyed).toBe(true);
      expect(backpressureSpy).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "drain_timeout" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // Mutation caught (a): not decrementing queuedOutboundBytes when write callback completes
  it("(a) partial progress: the queued byte counter decrements when callbacks fire", async () => {
    mockServer = createMockServer();
    const backpressureSpy = vi.fn();

    bridge = await startBridgeServer({
      endpoint: "test-pipe-partial-progress",
      key,
      createServer: () => mockServer,
      onRequest: async (_session: any, header: any) => {
        return {
          result: { id: header.id },
          body: Buffer.alloc(1024 * 1024, 0xbb),
        };
      },
      onBackpressure: backpressureSpy,
    });

    const [serverSocket, clientSocket] = createDuplexPair();
    mockServer.emit("connection", serverSocket);
    await clientHandshake(clientSocket, { key });

    const pendingCallbacks: Array<() => void> = [];
    serverSocket.write = vi.fn((_chunk: any, cb?: any) => {
      if (typeof cb === "function") {
        pendingCallbacks.push(cb);
      }
      return false; // Backpressure
    }) as any;

    // Send 3 requests (each > 1 MiB, total ~3 MiB < 4 MiB maxQueuedBytes)
    for (let id = 1; id <= 3; id++) {
      clientSocket.write(encodeFrame({ t: "req", id, method: "test.data" }));
    }
    await new Promise((r) => setTimeout(r, 80));

    expect(serverSocket.destroyed).toBe(false);
    expect(pendingCallbacks).toHaveLength(3);

    // Fire first 2 callbacks (partial progress: frees ~2 MiB from queued bytes counter).
    const cb1 = pendingCallbacks.shift()!;
    const cb2 = pendingCallbacks.shift()!;
    cb1();
    cb2();

    // Now send 2 more 1 MiB requests.
    // While reading is paused, these are buffered in pausedFrames.
    for (let id = 4; id <= 5; id++) {
      clientSocket.write(encodeFrame({ t: "req", id, method: "test.data" }));
    }
    await new Promise((r) => setTimeout(r, 50));

    // While paused, requests 4-5 have not been processed yet; pendingCallbacks still has only cb3
    expect(pendingCallbacks).toHaveLength(1);

    // Emit 'drain' to resume reading: reclaimed capacity allows requests 4-5 to be processed
    serverSocket.emit("drain");
    await new Promise((r) => setTimeout(r, 80));

    // Assert the remaining requests 4-5 ARE processed and their responses written (reclaimed capacity).
    // In mutant (no decrement), queuing responses 4 and 5 pushes queuedOutboundBytes over 4 MiB,
    // triggering buffer_overflow and destroying serverSocket.
    expect(serverSocket.destroyed).toBe(false);
    expect(serverSocket.write).toHaveBeenCalledTimes(5);
    // pendingCallbacks now has cb3 plus the write callbacks for responses 4 and 5
    expect(pendingCallbacks).toHaveLength(3);
    expect(backpressureSpy).not.toHaveBeenCalled();

    // Complete all remaining write callbacks (cb3, cb4, cb5)
    while (pendingCallbacks.length > 0) {
      const cb = pendingCallbacks.shift()!;
      cb();
    }

    // Queued-byte counter returns to 0
    expect((serverSocket as any).queuedOutboundBytes).toBe(0);
    expect(serverSocket.destroyed).toBe(false);
  });

  // Mutation caught (b): omitting socket.pause() on false return or socket.resume() on drain
  it("(b) pause reading when write returns false and resume on 'drain', repeated drain cycles keep the connection alive", async () => {
    mockServer = createMockServer();
    const backpressureSpy = vi.fn();
    let handledCount = 0;

    bridge = await startBridgeServer({
      endpoint: "test-pipe-pause-resume",
      key,
      createServer: () => mockServer,
      onRequest: async (_session: any, header: any) => {
        handledCount++;
        return { result: { echo: header.id } };
      },
      onBackpressure: backpressureSpy,
    });

    const [serverSocket, clientSocket] = createDuplexPair();
    mockServer.emit("connection", serverSocket);
    await clientHandshake(clientSocket, { key });

    const pauseSpy = vi.spyOn(serverSocket, "pause");
    const resumeSpy = vi.spyOn(serverSocket, "resume");

    let writeCb: (() => void) | null = null;
    serverSocket.write = vi.fn((_chunk: any, cb?: any) => {
      writeCb = cb;
      return false;
    }) as any;

    // Cycle 1: send request 1 -> write returns false -> pause() called
    clientSocket.write(encodeFrame({ t: "req", id: 1, method: "test.pause" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(handledCount).toBe(1);

    // While paused, send request 2: must be queued into pausedFrames and not handled yet
    clientSocket.write(encodeFrame({ t: "req", id: 2, method: "test.pause" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(handledCount).toBe(1);

    // Drain cycle 1: fire callback and emit drain
    if (writeCb) (writeCb as () => void)();
    serverSocket.emit("drain");

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 50));
    // Request 2 should now have been processed
    expect(handledCount).toBe(2);

    // Cycle 2: request 2 write returned false -> pause() called again
    expect(pauseSpy).toHaveBeenCalledTimes(2);

    // Drain cycle 2: fire callback and emit drain
    if (writeCb) (writeCb as () => void)();
    serverSocket.emit("drain");
    expect(resumeSpy).toHaveBeenCalledTimes(2);

    // Connection remains alive across repeated drain cycles
    expect(serverSocket.destroyed).toBe(false);
    expect(backpressureSpy).not.toHaveBeenCalled();
  });

  // Mutation caught (c): omitting clearTimeout(drainTimer) on drain or close
  it("(c) the 10 s no-drain deadline timer is cancelled on drain and on close (use fake timers; assert no timer remains)", async () => {
    vi.useFakeTimers();
    try {
      mockServer = createMockServer();

      bridge = await startBridgeServer({
        endpoint: "test-pipe-timer-cancel",
        key,
        createServer: () => mockServer,
        onRequest: async () => ({ result: { ok: true } }),
      });

      const [serverSocket, clientSocket] = createDuplexPair();
      mockServer.emit("connection", serverSocket);
      await clientHandshake(clientSocket, { key });

      serverSocket.write = vi.fn((_chunk: any, _cb?: any) => false) as any;

      // Part 1: drain cancels deadline timer
      clientSocket.write(encodeFrame({ t: "req", id: 1, method: "test.timer" }));
      await vi.advanceTimersByTimeAsync(50);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      serverSocket.emit("drain");
      expect(vi.getTimerCount()).toBe(0);

      // Part 2: close cancels deadline timer
      clientSocket.write(encodeFrame({ t: "req", id: 2, method: "test.timer" }));
      await vi.advanceTimersByTimeAsync(50);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      serverSocket.emit("close");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Mutation caught (d): accumulating drain timers across requests instead of resetting
  it("(d) a slow-but-draining client is never destroyed", async () => {
    vi.useFakeTimers();
    try {
      mockServer = createMockServer();
      const backpressureSpy = vi.fn();

      bridge = await startBridgeServer({
        endpoint: "test-pipe-slow-client",
        key,
        createServer: () => mockServer,
        onRequest: async (_session: any, header: any) => ({ result: { id: header.id } }),
        onBackpressure: backpressureSpy,
      });

      const [serverSocket, clientSocket] = createDuplexPair();
      mockServer.emit("connection", serverSocket);
      await clientHandshake(clientSocket, { key });

      let currentCb: (() => void) | null = null;
      serverSocket.write = vi.fn((_chunk: any, cb?: any) => {
        currentCb = cb;
        return false;
      }) as any;

      // 4 cycles of 6 seconds each = 24 seconds total elapsed time
      for (let i = 1; i <= 4; i++) {
        clientSocket.write(encodeFrame({ t: "req", id: i, method: "test.slow" }));
        await vi.advanceTimersByTimeAsync(50);

        await vi.advanceTimersByTimeAsync(6000);
        expect(serverSocket.destroyed).toBe(false);

        if (currentCb) (currentCb as () => void)();
        serverSocket.emit("drain");
      }

      expect(serverSocket.destroyed).toBe(false);
      expect(backpressureSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Mutation caught (e): omitting maxQueuedBytes check
  it("(e) exceeding the 4 MiB bound destroys", async () => {
    mockServer = createMockServer();
    const backpressureSpy = vi.fn();

    bridge = await startBridgeServer({
      endpoint: "test-pipe-4mib-bound",
      key,
      maxQueuedBytes: 4 * 1024 * 1024,
      createServer: () => mockServer,
      onRequest: async (_session: any, header: any) => {
        return {
          result: { id: header.id },
          body: Buffer.alloc(1024 * 1024, 0xcc),
        };
      },
      onBackpressure: backpressureSpy,
    });

    const [serverSocket, clientSocket] = createDuplexPair();
    mockServer.emit("connection", serverSocket);
    await clientHandshake(clientSocket, { key });

    serverSocket.write = vi.fn((_chunk: any, _cb?: any) => false) as any;

    // Send 5 requests (each > 1 MiB, total > 5 MiB > 4 MiB)
    for (let id = 1; id <= 5; id++) {
      clientSocket.write(encodeFrame({ t: "req", id, method: "test.overflow" }));
    }

    await new Promise((r) => setTimeout(r, 100));

    expect(serverSocket.destroyed).toBe(true);
    expect(backpressureSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "buffer_overflow" })
    );
  });
});
