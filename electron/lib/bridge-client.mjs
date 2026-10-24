import net from "node:net";
import { BridgeError, encodeFrame, clientHandshake } from "./bridge-proto.mjs";

/**
 * Connects to a local bridge server over a named pipe or Unix socket.
 * @param {{
 *   endpoint: string,
 *   key: Buffer,
 *   handshakeTimeoutMs?: number,
 *   connect?: (endpoint: string) => import("node:net").Socket
 * }} options
 * @returns {Promise<{
 *   sessionId: string,
 *   clientNonce: Buffer,
 *   serverNonce: Buffer,
 *   request: (method: string, params?: any, body?: Buffer) => Promise<{ result: any, body?: Buffer }>,
 *   close: () => Promise<void>
 * }>}
 */
export async function connectBridge({
  endpoint,
  key,
  handshakeTimeoutMs = 5000,
  connect,
}) {
  const socket = connect ? connect(endpoint) : net.connect(endpoint);

  if (socket.connecting) {
    await new Promise((resolve, reject) => {
      function onConnect() {
        socket.removeListener("error", onError);
        resolve();
      }
      function onError(err) {
        socket.removeListener("connect", onConnect);
        reject(err);
      }
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  const { sessionId, decoder, pending: early, clientNonce, serverNonce } = await clientHandshake(socket, {
    key,
    timeoutMs: handshakeTimeoutMs,
  });

  let nextId = 1;
  const pending = new Map();
  let closed = false;

  function cleanup() {
    if (closed) return;
    closed = true;
    for (const p of pending.values()) {
      try {
        p.reject(new BridgeError("closed"));
      } catch {}
    }
    pending.clear();
  }

  socket.once("close", () => cleanup());
  socket.once("error", () => cleanup());
  socket.once("end", () => cleanup());

  function handleFrame(frame) {
    const header = frame?.header;
    const body = frame?.body;

    if (header && header.t === "res" && header.id !== undefined) {
      const p = pending.get(header.id);
      if (p) {
        pending.delete(header.id);
        if (header.ok) {
          p.resolve({ result: header.result, body });
        } else {
          const code = header.error?.code || "unknown";
          p.reject(new BridgeError(code));
        }
      }
    }
  }

  try {
    for (const f of early) {
      handleFrame(f);
    }
  } catch {}

  socket.on("data", (chunk) => {
    try {
      const frames = decoder.push(chunk);
      for (const f of frames) {
        handleFrame(f);
      }
    } catch {
      cleanup();
      socket.destroy();
    }
  });

  return {
    sessionId,
    // The handshake nonces, for proofs bound to this connection (enrollProof).
    clientNonce,
    serverNonce,
    request(method, params = {}, body) {
      if (closed || socket.destroyed || !socket.writable) {
        return Promise.reject(new BridgeError("closed"));
      }

      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          const frame = encodeFrame({ t: "req", id, method, params }, body);
          socket.write(frame, (err) => {
            if (err) {
              if (pending.has(id)) {
                pending.delete(id);
                reject(new BridgeError("closed"));
              }
            }
          });
        } catch (err) {
          pending.delete(id);
          reject(err);
        }
      });
    },
    async close() {
      cleanup();
      try {
        socket.destroy();
      } catch {}
    },
  };
}
