import crypto from 'node:crypto';

/**
 * Maximum permitted size for the UTF-8 JSON header in bytes (64 KiB).
 * @type {number}
 */
export const MAX_HEADER_BYTES = 64 * 1024;

/**
 * Maximum permitted size for the raw frame body in bytes (2 MiB).
 * @type {number}
 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Default timeout for the handshake protocol in milliseconds (5 seconds).
 * @type {number}
 */
export const HANDSHAKE_TIMEOUT_MS = 5000;

/**
 * Required size for nonces in bytes (32 bytes / 256 bits).
 * @type {number}
 */
export const NONCE_BYTES = 32;

/**
 * Error class for bridge protocol framing, decoding, and handshake errors.
 */
export class BridgeError extends Error {
  /**
   * @param {"too_large" | "bad_frame" | "auth_failed" | "timeout" | "replay"} code
   * @param {string} [message]
   */
  constructor(code, message = code) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

/**
 * Encodes a message frame into wire format:
 * [4-byte BE header length] [UTF-8 JSON header] [4-byte BE body length] [raw body]
 *
 * @param {Record<string, unknown>} header Plain JSON object header.
 * @param {Uint8Array | Buffer} [body=new Uint8Array(0)] Optional body bytes.
 * @returns {Buffer} Encoded wire frame.
 * @throws {BridgeError} If header or body exceeds maximum allowed size or header is invalid.
 */
export function encodeFrame(header, body = new Uint8Array(0)) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new BridgeError('bad_frame', 'Header must be a non-null object');
  }

  const headerStr = JSON.stringify(header);
  const headerBuf = Buffer.from(headerStr, 'utf8');
  if (headerBuf.length > MAX_HEADER_BYTES) {
    throw new BridgeError('too_large', `Header size ${headerBuf.length} exceeds limit of ${MAX_HEADER_BYTES}`);
  }

  const bodyBuf = Buffer.isBuffer(body)
    ? body
    : Buffer.from(body.buffer || body, body.byteOffset || 0, body.byteLength !== undefined ? body.byteLength : body.length);
  if (bodyBuf.length > MAX_BODY_BYTES) {
    throw new BridgeError('too_large', `Body size ${bodyBuf.length} exceeds limit of ${MAX_BODY_BYTES}`);
  }

  const frame = Buffer.allocUnsafe(4 + headerBuf.length + 4 + bodyBuf.length);
  frame.writeUInt32BE(headerBuf.length, 0);
  headerBuf.copy(frame, 4);
  frame.writeUInt32BE(bodyBuf.length, 4 + headerBuf.length);
  bodyBuf.copy(frame, 8 + headerBuf.length);

  return frame;
}

const STATE_HEADER_LEN = 0;
const STATE_HEADER_BODY = 1;
const STATE_BODY_LEN = 2;
const STATE_BODY_BYTES = 3;

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Incremental frame decoder that decodes incoming chunks into frames.
 * Lengths are validated before buffering or parsing frame payloads.
 */
export class FrameDecoder {
  constructor() {
    /** @type {Buffer} */
    this._buffer = Buffer.alloc(0);
    this._state = STATE_HEADER_LEN;
    this._headerLen = 0;
    this._bodyLen = 0;
    /** @type {Record<string, unknown> | null} */
    this._header = null;
    /** @type {BridgeError | null} */
    this._error = null;
  }

  /**
   * Push raw chunk into decoder and return any complete frames.
   *
   * @param {Buffer | Uint8Array} [chunk]
   * @returns {Array<{ header: Record<string, unknown>, body: Buffer }>}
   * @throws {BridgeError}
   */
  push(chunk) {
    if (this._error) {
      throw this._error;
    }

    if (chunk && chunk.length > 0) {
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer || chunk, chunk.byteOffset || 0, chunk.byteLength !== undefined ? chunk.byteLength : chunk.length);
      this._buffer = this._buffer.length === 0 ? buf : Buffer.concat([this._buffer, buf]);
    }

    const frames = [];

    try {
      while (true) {
        if (this._state === STATE_HEADER_LEN) {
          if (this._buffer.length < 4) {
            break;
          }
          const hLen = this._buffer.readUInt32BE(0);
          this._buffer = this._buffer.subarray(4);
          if (hLen > MAX_HEADER_BYTES) {
            throw new BridgeError('too_large', `Header length ${hLen} exceeds limit of ${MAX_HEADER_BYTES}`);
          }
          this._headerLen = hLen;
          this._state = STATE_HEADER_BODY;
        }

        if (this._state === STATE_HEADER_BODY) {
          if (this._buffer.length < this._headerLen) {
            break;
          }
          const headerBytes = this._buffer.subarray(0, this._headerLen);
          this._buffer = this._buffer.subarray(this._headerLen);

          let jsonText;
          try {
            jsonText = utf8Decoder.decode(headerBytes);
          } catch (_) {
            throw new BridgeError('bad_frame', 'Header contains invalid UTF-8');
          }

          let parsed;
          try {
            parsed = JSON.parse(jsonText);
          } catch (_) {
            throw new BridgeError('bad_frame', 'Header is not valid JSON');
          }

          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new BridgeError('bad_frame', 'Header must be a JSON object');
          }

          this._header = parsed;
          this._state = STATE_BODY_LEN;
        }

        if (this._state === STATE_BODY_LEN) {
          if (this._buffer.length < 4) {
            break;
          }
          const bLen = this._buffer.readUInt32BE(0);
          this._buffer = this._buffer.subarray(4);
          if (bLen > MAX_BODY_BYTES) {
            throw new BridgeError('too_large', `Body length ${bLen} exceeds limit of ${MAX_BODY_BYTES}`);
          }
          this._bodyLen = bLen;
          this._state = STATE_BODY_BYTES;
        }

        if (this._state === STATE_BODY_BYTES) {
          if (this._buffer.length < this._bodyLen) {
            break;
          }
          const bodyBytes = Buffer.from(this._buffer.subarray(0, this._bodyLen));
          this._buffer = this._buffer.subarray(this._bodyLen);

          frames.push({
            header: this._header,
            body: bodyBytes,
          });

          this._header = null;
          this._headerLen = 0;
          this._bodyLen = 0;
          this._state = STATE_HEADER_LEN;
        }
      }

      return frames;
    } catch (err) {
      const bridgeErr = err instanceof BridgeError ? err : new BridgeError('bad_frame', err.message);
      this._error = bridgeErr;
      throw bridgeErr;
    }
  }
}

/**
 * Encodes transcript fields as length-prefixed chunks:
 * Each field is encoded as a 4-byte big-endian length followed by field bytes.
 *
 * @param {...(string | Buffer | Uint8Array)} fields
 * @returns {Buffer}
 */
export function transcript(...fields) {
  const parts = [];
  let totalLength = 0;

  for (const field of fields) {
    let buf;
    if (typeof field === 'string') {
      buf = Buffer.from(field, 'ascii');
    } else if (Buffer.isBuffer(field)) {
      buf = field;
    } else if (field instanceof Uint8Array) {
      buf = Buffer.from(field.buffer, field.byteOffset, field.byteLength);
    } else {
      throw new TypeError('transcript fields must be string, Buffer, or Uint8Array');
    }

    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32BE(buf.length, 0);
    parts.push(lenBuf, buf);
    totalLength += 4 + buf.length;
  }

  return Buffer.concat(parts, totalLength);
}

/**
 * Computes HMAC-SHA256 of data using the given key.
 *
 * @param {Buffer | Uint8Array | string} key
 * @param {Buffer} data
 * @returns {Buffer}
 */
function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/**
 * Computes server proof: HMAC-SHA256(key, T("srv", clientNonce, serverNonce)).
 *
 * @param {Buffer | Uint8Array | string} key
 * @param {Buffer | Uint8Array} clientNonce
 * @param {Buffer | Uint8Array} serverNonce
 * @returns {Buffer} 32-byte proof buffer.
 */
export function serverProof(key, clientNonce, serverNonce) {
  return hmacSha256(key, transcript('srv', clientNonce, serverNonce));
}

/**
 * Computes client proof: HMAC-SHA256(key, T("cli", serverNonce, clientNonce)).
 *
 * @param {Buffer | Uint8Array | string} key
 * @param {Buffer | Uint8Array} serverNonce
 * @param {Buffer | Uint8Array} clientNonce
 * @returns {Buffer} 32-byte proof buffer.
 */
export function clientProof(key, serverNonce, clientNonce) {
  return hmacSha256(key, transcript('cli', serverNonce, clientNonce));
}

/**
 * Computes enrollment proof: HMAC-SHA256(clientKey, T("enroll", serverNonce, clientNonce)).
 *
 * @param {Buffer | Uint8Array | string} clientKey
 * @param {Buffer | Uint8Array} serverNonce
 * @param {Buffer | Uint8Array} clientNonce
 * @returns {Buffer} 32-byte proof buffer.
 */
export function enrollProof(clientKey, serverNonce, clientNonce) {
  return hmacSha256(clientKey, transcript('enroll', serverNonce, clientNonce));
}

/**
 * Tracks recent client nonces to prevent replay attacks within a TTL window.
 */
export class ReplayWindow {
  /**
   * @param {{ max?: number, ttlMs?: number, now?: () => number }} [options]
   */
  constructor({ max = 4096, ttlMs = 600_000, now = Date.now } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Map<string, number>} */
    this._entries = new Map();
  }

  /**
   * Checks whether the nonce is fresh and records it if so.
   *
   * @param {Buffer | Uint8Array} nonce
   * @returns {boolean} true if new and recorded, false if seen within ttlMs.
   */
  checkAndRemember(nonce) {
    const key = (Buffer.isBuffer(nonce) ? nonce : Buffer.from(nonce)).toString('hex');
    const currentTime = this.now();

    if (this._entries.has(key)) {
      const ts = this._entries.get(key);
      if (currentTime - ts <= this.ttlMs) {
        return false;
      }
      this._entries.delete(key);
    }

    for (const [k, ts] of this._entries) {
      if (currentTime - ts > this.ttlMs) {
        this._entries.delete(k);
      }
    }

    while (this._entries.size >= this.max) {
      const oldestKey = this._entries.keys().next().value;
      this._entries.delete(oldestKey);
    }

    this._entries.set(key, currentTime);
    return true;
  }
}

/**
 * Converts Buffer, Uint8Array, or string to Buffer.
 *
 * @param {Buffer | Uint8Array | string} val
 * @returns {Buffer}
 */
function toBuffer(val) {
  if (Buffer.isBuffer(val)) return val;
  if (val instanceof Uint8Array) return Buffer.from(val.buffer, val.byteOffset, val.byteLength);
  return Buffer.from(val);
}

/**
 * Safely compares two buffers with timingSafeEqual if lengths match.
 *
 * @param {Buffer | null | undefined} a
 * @param {Buffer | null | undefined} b
 * @returns {boolean}
 */
function timingSafeEqualBuffers(a, b) {
  if (!a || !b) return false;
  const bufA = toBuffer(a);
  const bufB = toBuffer(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Executes the server side of the mutual handshake.
 *
 * @param {import('node:stream').Duplex} stream
 * @param {{
 *   key: Buffer | Uint8Array | string,
 *   replay?: ReplayWindow,
 *   timeoutMs?: number,
 *   randomBytes?: (size: number) => Buffer
 * }} options
 * @returns {Promise<{
 *   sessionId: string,
 *   clientNonce: Buffer,
 *   serverNonce: Buffer,
 *   decoder: FrameDecoder
 * }>}
 */
export async function serverHandshake(stream, {
  key,
  replay,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
  randomBytes = crypto.randomBytes,
}) {
  const decoder = new FrameDecoder();
  const queue = [];
  let waiter = null;
  let waiterReject = null;
  let handshakeErr = null;
  let cleanedUp = false;

  const onData = (chunk) => {
    try {
      const frames = decoder.push(chunk);
      for (const frame of frames) {
        if (waiter) {
          const res = waiter;
          waiter = null;
          waiterReject = null;
          res(frame);
        } else {
          queue.push(frame);
        }
      }
    } catch (err) {
      fail(err);
    }
  };

  const onError = (err) => {
    fail(err instanceof BridgeError ? err : new BridgeError('bad_frame', err.message));
  };

  const onClose = () => {
    fail(new BridgeError('bad_frame', 'Stream closed during handshake'));
  };

  const fail = (err) => {
    if (!handshakeErr) {
      handshakeErr = err;
    }
    if (waiterReject) {
      const rej = waiterReject;
      waiter = null;
      waiterReject = null;
      rej(err);
    }
  };

  stream.on('data', onData);
  stream.on('error', onError);
  stream.on('close', onClose);

  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new BridgeError('timeout', 'Handshake timed out');
      try {
        stream.destroy();
      } catch (_) {}
      fail(err);
      reject(err);
    }, timeoutMs);
  });

  const nextFrame = () => {
    if (handshakeErr) {
      return Promise.reject(handshakeErr);
    }
    if (queue.length > 0) {
      return Promise.resolve(queue.shift());
    }
    return new Promise((resolve, reject) => {
      waiter = resolve;
      waiterReject = reject;
    });
  };

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (timer) clearTimeout(timer);
    stream.removeListener('data', onData);
    stream.removeListener('error', onError);
    stream.removeListener('close', onClose);
  };

  try {
    const handshakeLogic = async () => {
      const helloFrame = await nextFrame();
      const hello = helloFrame.header;
      if (hello.t !== 'hello' || hello.v !== 1 || typeof hello.clientNonce !== 'string') {
        throw new BridgeError('bad_frame', 'Expected valid hello frame');
      }

      const clientNonce = Buffer.from(hello.clientNonce, 'base64');
      if (clientNonce.length !== NONCE_BYTES) {
        throw new BridgeError('bad_frame', `clientNonce must be ${NONCE_BYTES} bytes`);
      }

      if (replay) {
        const isFresh = replay.checkAndRemember(clientNonce);
        if (!isFresh) {
          throw new BridgeError('replay', 'Replay of clientNonce detected');
        }
      }

      const serverNonce = toBuffer(randomBytes(NONCE_BYTES));
      if (serverNonce.length !== NONCE_BYTES) {
        throw new BridgeError('bad_frame', `serverNonce must be ${NONCE_BYTES} bytes`);
      }

      const sProof = serverProof(key, clientNonce, serverNonce);
      stream.write(encodeFrame({
        t: 'challenge',
        serverNonce: serverNonce.toString('base64'),
        serverProof: sProof.toString('base64'),
      }));

      const proofFrame = await nextFrame();
      const proofMsg = proofFrame.header;
      if (proofMsg.t !== 'proof' || typeof proofMsg.clientProof !== 'string') {
        throw new BridgeError('bad_frame', 'Expected valid proof frame');
      }

      const clientProofBuf = Buffer.from(proofMsg.clientProof, 'base64');
      const expectedProof = clientProof(key, serverNonce, clientNonce);
      if (!timingSafeEqualBuffers(clientProofBuf, expectedProof)) {
        try {
          stream.write(encodeFrame({ t: 'error', code: 'auth_failed' }));
        } catch (_) {}
        throw new BridgeError('auth_failed', 'Client proof verification failed');
      }

      const sessionIdBytes = toBuffer(randomBytes(16));
      const sessionId = sessionIdBytes.toString('hex');
      stream.write(encodeFrame({ t: 'ready', sessionId }));

      if (queue.length > 0) {
        const leftoverBuffers = [];
        for (const f of queue) {
          leftoverBuffers.push(encodeFrame(f.header, f.body));
        }
        decoder._buffer = Buffer.concat([...leftoverBuffers, decoder._buffer]);
      }

      return {
        sessionId,
        clientNonce,
        serverNonce,
        decoder,
      };
    };

    return await Promise.race([handshakeLogic(), timeoutPromise]);
  } catch (err) {
    try {
      stream.destroy();
    } catch (_) {}
    throw err;
  } finally {
    cleanup();
  }
}

/**
 * Executes the client side of the mutual handshake.
 *
 * @param {import('node:stream').Duplex} stream
 * @param {{
 *   key: Buffer | Uint8Array | string,
 *   timeoutMs?: number,
 *   randomBytes?: (size: number) => Buffer
 * }} options
 * @returns {Promise<{
 *   sessionId: string,
 *   clientNonce: Buffer,
 *   serverNonce: Buffer,
 *   decoder: FrameDecoder
 * }>}
 */
export async function clientHandshake(stream, {
  key,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
  randomBytes = crypto.randomBytes,
}) {
  const decoder = new FrameDecoder();
  const queue = [];
  let waiter = null;
  let waiterReject = null;
  let handshakeErr = null;
  let cleanedUp = false;

  const onData = (chunk) => {
    try {
      const frames = decoder.push(chunk);
      for (const frame of frames) {
        if (waiter) {
          const res = waiter;
          waiter = null;
          waiterReject = null;
          res(frame);
        } else {
          queue.push(frame);
        }
      }
    } catch (err) {
      fail(err);
    }
  };

  const onError = (err) => {
    fail(err instanceof BridgeError ? err : new BridgeError('bad_frame', err.message));
  };

  const onClose = () => {
    fail(new BridgeError('bad_frame', 'Stream closed during handshake'));
  };

  const fail = (err) => {
    if (!handshakeErr) {
      handshakeErr = err;
    }
    if (waiterReject) {
      const rej = waiterReject;
      waiter = null;
      waiterReject = null;
      rej(err);
    }
  };

  stream.on('data', onData);
  stream.on('error', onError);
  stream.on('close', onClose);

  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new BridgeError('timeout', 'Handshake timed out');
      try {
        stream.destroy();
      } catch (_) {}
      fail(err);
      reject(err);
    }, timeoutMs);
  });

  const nextFrame = () => {
    if (handshakeErr) {
      return Promise.reject(handshakeErr);
    }
    if (queue.length > 0) {
      return Promise.resolve(queue.shift());
    }
    return new Promise((resolve, reject) => {
      waiter = resolve;
      waiterReject = reject;
    });
  };

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (timer) clearTimeout(timer);
    stream.removeListener('data', onData);
    stream.removeListener('error', onError);
    stream.removeListener('close', onClose);
  };

  try {
    const handshakeLogic = async () => {
      const clientNonce = toBuffer(randomBytes(NONCE_BYTES));
      if (clientNonce.length !== NONCE_BYTES) {
        throw new BridgeError('bad_frame', `clientNonce must be ${NONCE_BYTES} bytes`);
      }

      stream.write(encodeFrame({
        t: 'hello',
        v: 1,
        clientNonce: clientNonce.toString('base64'),
      }));

      const challengeFrame = await nextFrame();
      const challenge = challengeFrame.header;

      if (challenge.t === 'error') {
        throw new BridgeError(challenge.code || 'auth_failed', 'Server returned error');
      }

      if (challenge.t !== 'challenge' || typeof challenge.serverNonce !== 'string' || typeof challenge.serverProof !== 'string') {
        throw new BridgeError('bad_frame', 'Expected valid challenge frame');
      }

      const serverNonce = Buffer.from(challenge.serverNonce, 'base64');
      if (serverNonce.length !== NONCE_BYTES) {
        throw new BridgeError('bad_frame', `serverNonce must be ${NONCE_BYTES} bytes`);
      }

      const serverProofBuf = Buffer.from(challenge.serverProof, 'base64');
      const expectedServerProof = serverProof(key, clientNonce, serverNonce);

      if (!timingSafeEqualBuffers(serverProofBuf, expectedServerProof)) {
        try {
          stream.destroy();
        } catch (_) {}
        throw new BridgeError('auth_failed', 'Server proof verification failed');
      }

      const cProof = clientProof(key, serverNonce, clientNonce);
      stream.write(encodeFrame({
        t: 'proof',
        clientProof: cProof.toString('base64'),
      }));

      const readyFrame = await nextFrame();
      const ready = readyFrame.header;

      if (ready.t === 'error') {
        throw new BridgeError(ready.code || 'auth_failed', 'Server returned error');
      }

      if (ready.t !== 'ready' || typeof ready.sessionId !== 'string' || !/^[0-9a-fA-F]{32}$/.test(ready.sessionId)) {
        throw new BridgeError('bad_frame', 'Expected valid ready frame');
      }

      if (queue.length > 0) {
        const leftoverBuffers = [];
        for (const f of queue) {
          leftoverBuffers.push(encodeFrame(f.header, f.body));
        }
        decoder._buffer = Buffer.concat([...leftoverBuffers, decoder._buffer]);
      }

      return {
        sessionId: ready.sessionId,
        clientNonce,
        serverNonce,
        decoder,
      };
    };

    return await Promise.race([handshakeLogic(), timeoutPromise]);
  } catch (err) {
    try {
      stream.destroy();
    } catch (_) {}
    throw err;
  } finally {
    cleanup();
  }
}
