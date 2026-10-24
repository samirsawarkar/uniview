import net from "node:net";
import fsPromises from "node:fs/promises";
import { BridgeError, encodeFrame, ReplayWindow, serverHandshake } from "./bridge-proto.mjs";

const defaultConnect = (endpoint) => net.connect(endpoint);

/**
 * Starts the local bridge server on the rendezvous endpoint.
 * @param {{
 *   endpoint: string,
 *   key: Buffer,
 *   onRequest: (session: { sessionId: string }, header: any, body?: Buffer) => Promise<{ result?: any, body?: Buffer }>,
 *   onSessionClosed?: (sessionId: string) => void,
 *   maxConnections?: number,
 *   maxInFlight?: number,
 *   handshakeTimeoutMs?: number,
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
  maxInFlight = 16,
  handshakeTimeoutMs = 5000,
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

      const isSocket =
        typeof st.isSocket === "function"
          ? st.isSocket()
          : (st.mode & 0o170000) === 0o140000;
      const isOwner =
        typeof process.getuid === "function" ? st.uid === process.getuid() : true;

      if (isSocket && isOwner) {
        await fs.unlink(endpoint);
      } else {
        throw new BridgeError("endpoint_not_ours");
      }
    }
  }

  const replay = new ReplayWindow();
  const activeConnections = new Set();
  const server = net.createServer();

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
    if (activeConnections.size >= maxConnections) {
      try {
        socket.end(encodeFrame({ t: "error", code: "busy" }));
      } catch {
        socket.destroy();
      }
      return;
    }

    activeConnections.add(socket);
    socket.once("close", () => {
      activeConnections.delete(socket);
    });

    let handshakeResult;
    try {
      handshakeResult = await serverHandshake(socket, {
        key,
        replay,
        timeoutMs: handshakeTimeoutMs,
      });
    } catch {
      return;
    }

    const { sessionId, decoder, pending } = handshakeResult;
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

    let inFlight = 0;

    const handleFrame = (frame) => {
      const header = frame?.header;
      const body = frame?.body;

      if (
        !header ||
        typeof header !== "object" ||
        header.t !== "req" ||
        (typeof header.id !== "string" && typeof header.id !== "number") ||
        (typeof header.id === "number" && !Number.isFinite(header.id))
      ) {
        try {
          socket.end(encodeFrame({ t: "error", code: "bad_frame" }));
        } catch {
          socket.destroy();
        }
        return;
      }

      if (inFlight >= maxInFlight) {
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
        return;
      }

      inFlight++;
      (async () => {
        try {
          const res = await onRequest({ sessionId }, header, body);
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
          inFlight--;
        }
      })();
    };

    try {
      // Frames that arrived together with the last handshake frame come first.
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
