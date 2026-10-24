import net from "node:net";
import fsPromises from "node:fs/promises";
import { BridgeError, encodeFrame, ReplayWindow, serverHandshake } from "./bridge-proto.mjs";

const defaultConnect = (endpoint) => net.connect(endpoint);

/**
 * Attaches a persistent error listener to a socket that prevents unhandled error crashes,
 * destroys the socket, and invokes onError exactly once.
 * @param {import("node:net").Socket | import("node:stream").Duplex} socket
 * @param {(err: any) => void} [onError]
 * @returns {(err: any) => void}
 */
export function attachSocketGuards(socket, onError) {
  let handled = false;
  const errorHandler = (err) => {
    if (handled) return;
    handled = true;
    try {
      socket.destroy();
    } catch {}
    if (typeof onError === "function") {
      try {
        onError(err);
      } catch {}
    }
  };
  socket.on("error", errorHandler);
  return errorHandler;
}

/**
 * Creates a rate-limited logger for authentication failures.
 * Logs up to 10 failures per minute, then one summary line per minute.
 * @param {{ log?: (...args: any[]) => void, now?: () => number }} [options]
 * @returns {({ code }: { code: string }) => void}
 */
export function createAuthFailureLogger({
  log = console.warn,
  now = Date.now,
} = {}) {
  let windowStart = 0;
  let count = 0;
  let suppressed = 0;
  let flushTimer = null;

  function flushSuppressed(warnFn) {
    if (suppressed > 0) {
      warnFn(`… ${suppressed} more failures suppressed`);
      suppressed = 0;
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  return function authFailureLogger({ code } = {}) {
    const getTime = typeof now === "function" ? now : Date.now;
    const warnFn = typeof log === "function" ? log : console.warn;
    const current = getTime();

    if (current - windowStart >= 60000) {
      flushSuppressed(warnFn);
      windowStart = current;
      count = 0;
    }

    if (count < 10) {
      count++;
      warnFn(`Bridge handshake failed: ${code}`);
    } else {
      suppressed++;
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushSuppressed(warnFn);
          windowStart = getTime();
          count = 0;
        }, 60000);
        if (flushTimer && flushTimer.unref) flushTimer.unref();
      }
    }
  };
}

export const defaultAuthFailureLogger = createAuthFailureLogger();

/**
 * Starts the local bridge server on the rendezvous endpoint.
 * @param {{
 *   endpoint: string,
 *   key: Buffer,
 *   onRequest: (session: { sessionId: string, clientNonce: Buffer, serverNonce: Buffer }, header: any, body?: Buffer) => Promise<{ result?: any, body?: Buffer }>,
 *   onSessionClosed?: (sessionId: string) => void,
 *   maxConnections?: number,
 *   maxHandshakes?: number,
 *   createServer?: () => import('node:net').Server,
 *   maxInFlight?: number,
 *   handshakeTimeoutMs?: number,
 *   onAuthFailure?: ({ code }: { code: string }) => void,
 *   platform?: string,
 *   fs?: typeof import("node:fs/promises"),
 *   connect?: (endpoint: string) => import("node:net").Socket
 * }} options
 * @returns {Promise<{ close(): Promise<void>, connectionCount(): number }>}
 */
export async function startBridgeServer({
  endpoint,
  key,
  onRequest,
  onSessionClosed = () => {},
  maxConnections = 8,
  maxHandshakes = 8,
  createServer = net.createServer,
  maxInFlight = 16,
  handshakeTimeoutMs = 5000,
  onAuthFailure = defaultAuthFailureLogger,
  platform = process.platform,
  fs = fsPromises,
  connect = defaultConnect,
}) {
  if (platform !== "win32") {
    let st;
    try {
      st = await fs.lstat(endpoint);
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }

    if (st) {
      const isSocket1 =
        typeof st.isSocket === "function"
          ? st.isSocket()
          : (st.mode & 0o170000) === 0o140000;
      const isOwner1 =
        typeof process.getuid === "function" ? st.uid === process.getuid() : true;

      if (!isSocket1 || !isOwner1) {
        throw new BridgeError("endpoint_not_ours");
      }

      const answers = await new Promise((resolve) => {
        let connected = false;
        let s;
        try {
          s = connect(endpoint);
          s.once("connect", () => {
            connected = true;
            s.destroy();
            resolve(true);
          });
          s.once("error", () => {
            if (!connected) {
              s.destroy();
              resolve(false);
            }
          });
        } catch {
          resolve(false);
        }
      });

      if (answers) {
        throw new BridgeError("endpoint_in_use");
      }

      let st2;
      try {
        st2 = await fs.lstat(endpoint);
      } catch {
        throw new BridgeError("endpoint_not_ours");
      }

      const isSocket2 =
        typeof st2.isSocket === "function"
          ? st2.isSocket()
          : (st2.mode & 0o170000) === 0o140000;
      const isOwner2 =
        typeof process.getuid === "function" ? st2.uid === process.getuid() : true;

      if (
        !isSocket2 ||
        !isOwner2 ||
        st2.dev !== st.dev ||
        st2.ino !== st.ino
      ) {
        throw new BridgeError("endpoint_not_ours");
      }

      await fs.unlink(endpoint);
    }
  }

  const replay = new ReplayWindow();
  const activeConnections = new Set();
  const handshakingConnections = new Set();
  const rejectedSockets = new Set();
  const server = createServer();

  function rejectConnection(socket) {
    rejectedSockets.add(socket);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      rejectedSockets.delete(socket);
      try {
        socket.destroy();
      } catch {}
    };

    socket.once("close", () => {
      cleaned = true;
      clearTimeout(timer);
      rejectedSockets.delete(socket);
    });

    const timer = setTimeout(() => {
      cleanup();
    }, 1000);
    if (timer.unref) timer.unref();

    try {
      const frame = encodeFrame({ t: "error", code: "busy" });
      socket.write(frame, () => {
        cleanup();
      });
    } catch {
      cleanup();
    }
  }

  await new Promise((resolve, reject) => {
    function onError(err) {
      server.removeListener("listening", onListening);
      if (err && (err.code === "EADDRINUSE" || err.message?.includes("EADDRINUSE"))) {
        reject(new BridgeError("endpoint_in_use"));
      } else {
        reject(err);
      }
    }
    function onListening() {
      server.removeListener("error", onError);
      resolve();
    }
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });

  if (platform !== "win32") {
    try {
      await fs.chmod(endpoint, 0o600);
    } catch {}
  }

  server.on("connection", async (socket) => {
    attachSocketGuards(socket);

    if (activeConnections.size >= maxConnections || handshakingConnections.size >= maxHandshakes) {
      rejectConnection(socket);
      return;
    }

    handshakingConnections.add(socket);
    socket.once("close", () => {
      handshakingConnections.delete(socket);
    });

    let handshakeResult;
    try {
      handshakeResult = await serverHandshake(socket, {
        key,
        replay,
        timeoutMs: handshakeTimeoutMs,
      });
    } catch (err) {
      handshakingConnections.delete(socket);
      const code =
        err instanceof BridgeError && err.code ? err.code : (err?.code || "auth_failed");
      try {
        onAuthFailure({ code });
      } catch {}
      try {
        socket.destroy();
      } catch {}
      return;
    }

    handshakingConnections.delete(socket);

    if (activeConnections.size >= maxConnections) {
      rejectConnection(socket);
      return;
    }

    activeConnections.add(socket);
    socket.once("close", () => {
      activeConnections.delete(socket);
    });

    const { sessionId, decoder, pending, clientNonce, serverNonce } = handshakeResult;
    // Handed to onRequest so an enrolled client's proof (bound to these nonces) can be verified.
    const session = { sessionId, clientNonce, serverNonce };
    let sessionClosedFired = false;
    const fireSessionClosed = () => {
      if (!sessionClosedFired) {
        sessionClosedFired = true;
        try {
          onSessionClosed(sessionId);
        } catch {}
      }
    };
    socket.once("close", fireSessionClosed);

    const inFlightIds = new Set();

    function isValidRequestId(id) {
      if (typeof id === "number") {
        return Number.isSafeInteger(id) && id >= 0;
      }
      if (typeof id === "string") {
        return id.length > 0 && id.length <= 64;
      }
      return false;
    }

    const handleFrame = (frame) => {
      const header = frame?.header;
      const body = frame?.body;

      if (
        !header ||
        typeof header !== "object" ||
        header.t !== "req" ||
        !isValidRequestId(header.id)
      ) {
        try {
          socket.end(encodeFrame({ t: "error", code: "bad_frame" }));
        } catch {
          socket.destroy();
        }
        return;
      }

      if (body && body.length > 2 * 1024 * 1024) {
        try {
          socket.end(encodeFrame({ t: "error", code: "too_large" }));
        } catch {
          socket.destroy();
        }
        return;
      }

      if (inFlightIds.has(header.id)) {
        if (socket.writable) {
          try {
            socket.write(
              encodeFrame({
                t: "res",
                id: header.id,
                ok: false,
                error: { code: "duplicate_id" },
              })
            );
          } catch {}
        }
        return;
      }

      // review.cancelWait ends something the client already holds and answers at once, so it is never refused for
      // being over the limit (the MCP server keeps one slot free for it, but the bridge does not depend on that).
      if (inFlightIds.size >= maxInFlight && header.method !== "review.cancelWait") {
        if (socket.writable) {
          try {
            socket.write(
              encodeFrame({
                t: "res",
                id: header.id,
                ok: false,
                error: { code: "busy" },
              })
            );
          } catch {}
        }
        return;
      }

      inFlightIds.add(header.id);
      (async () => {
        try {
          const res = await onRequest(session, header, body);
          const result =
            res && typeof res === "object" && "result" in res
              ? res.result
              : undefined;
          const resBody =
            res && typeof res === "object" && "body" in res ? res.body : undefined;
          if (socket.writable) {
            socket.write(
              encodeFrame({ t: "res", id: header.id, ok: true, result }, resBody)
            );
          }
        } catch (err) {
          const code =
            err instanceof BridgeError && err.code ? err.code : "internal";
          if (socket.writable) {
            socket.write(
              encodeFrame({
                t: "res",
                id: header.id,
                ok: false,
                error: { code },
              })
            );
          }
        } finally {
          inFlightIds.delete(header.id);
        }
      })();
    };

    try {
      for (const f of pending) {
        handleFrame(f);
      }
    } catch (err) {
      const code =
        err instanceof BridgeError && err.code ? err.code : "bad_frame";
      try {
        socket.end(encodeFrame({ t: "error", code }));
      } catch {
        socket.destroy();
      }
      return;
    }

    socket.on("data", (chunk) => {
      try {
        const frames = decoder.push(chunk);
        for (const f of frames) {
          handleFrame(f);
        }
      } catch (err) {
        const code =
          err instanceof BridgeError && err.code ? err.code : "bad_frame";
        try {
          socket.end(encodeFrame({ t: "error", code }));
        } catch {
          socket.destroy();
        }
      }
    });
  });

  return {
    async close() {
      for (const socket of rejectedSockets) {
        try {
          socket.destroy();
        } catch {}
      }
      rejectedSockets.clear();
      for (const socket of handshakingConnections) {
        try {
          socket.destroy();
        } catch {}
      }
      handshakingConnections.clear();
      for (const socket of activeConnections) {
        try {
          socket.destroy();
        } catch {}
      }
      activeConnections.clear();
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
      if (platform !== "win32") {
        try {
          await fs.unlink(endpoint);
        } catch {}
      }
    },
    connectionCount() {
      return activeConnections.size;
    },
  };
}
