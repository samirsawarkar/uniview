import { describe, it, expect, vi } from 'vitest';
import { Duplex } from 'node:stream';
import crypto from 'node:crypto';
// @ts-expect-error plain ESM module without types
import { encodeFrame, FrameDecoder, BridgeError, transcript, serverProof, clientProof, enrollProof, ReplayWindow, serverHandshake, clientHandshake, MAX_HEADER_BYTES, MAX_BODY_BYTES, HANDSHAKE_TIMEOUT_MS, NONCE_BYTES } from '../../electron/lib/bridge-proto.mjs';

/**
 * Creates a connected in-memory duplex stream pair.
 */
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

describe('Packet P15b-1: bridge wire protocol', () => {
  describe('Framing & Decoder', () => {
    // Mutation caught: encoding or decoding body bytes or header incorrectly in roundtrip
    it('round trip with a body', () => {
      const header = { t: 'msg', id: '123', meta: { ok: true } };
      const body = Buffer.from('hello payload world');
      const frame = encodeFrame(header, body);

      const decoder = new FrameDecoder();
      const frames = decoder.push(frame);

      expect(frames).toHaveLength(1);
      expect(frames[0].header).toEqual(header);
      expect(frames[0].body).toEqual(body);
    });

    // Mutation caught: failing to handle frames split byte-by-byte across chunks
    it('handles a frame split byte-by-byte', () => {
      const header = { t: 'chunked', seq: 1 };
      const body = Buffer.from('byte-by-byte-data');
      const frame = encodeFrame(header, body);

      const decoder = new FrameDecoder();
      const collected = [];
      for (let i = 0; i < frame.length; i++) {
        const res = decoder.push(frame.subarray(i, i + 1));
        collected.push(...res);
      }

      expect(collected).toHaveLength(1);
      expect(collected[0].header).toEqual(header);
      expect(collected[0].body).toEqual(body);
    });

    // Mutation caught: failing to process multiple frames inside a single chunk
    it('handles two frames in one chunk', () => {
      const h1 = { t: 'first' };
      const b1 = Buffer.from('b1');
      const h2 = { t: 'second' };
      const b2 = Buffer.from('b2');

      const combined = Buffer.concat([encodeFrame(h1, b1), encodeFrame(h2, b2)]);
      const decoder = new FrameDecoder();
      const frames = decoder.push(combined);

      expect(frames).toHaveLength(2);
      expect(frames[0].header).toEqual(h1);
      expect(frames[0].body).toEqual(b1);
      expect(frames[1].header).toEqual(h2);
      expect(frames[1].body).toEqual(b2);
    });

    // Mutation caught: rejecting header of exactly MAX_HEADER_BYTES (64 KiB)
    it('header exactly 64 KiB passes', () => {
      const prefix = '{"pad":"';
      const suffix = '"}';
      const padLen = MAX_HEADER_BYTES - (prefix.length + suffix.length);
      const header = { pad: 'a'.repeat(padLen) };
      expect(Buffer.byteLength(JSON.stringify(header), 'utf8')).toBe(MAX_HEADER_BYTES);

      const frame = encodeFrame(header);
      const decoder = new FrameDecoder();
      const frames = decoder.push(frame);

      expect(frames).toHaveLength(1);
      expect(frames[0].header).toEqual(header);
    });

    // Mutation caught: not rejecting oversized header length (> 64 KiB) immediately upon reading 4 length bytes
    it('header 64 KiB + 1 throws too_large as soon as 4 length bytes arrive', () => {
      const decoder = new FrameDecoder();
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(MAX_HEADER_BYTES + 1, 0);

      expect(() => decoder.push(lenBuf)).toThrowError(
        expect.objectContaining({ code: 'too_large' })
      );
    });

    // Mutation caught: rejecting body of exactly MAX_BODY_BYTES (2 MiB)
    it('body exactly 2 MiB passes', () => {
      const body = Buffer.alloc(MAX_BODY_BYTES, 0x7a);
      const frame = encodeFrame({ t: 'large' }, body);

      const decoder = new FrameDecoder();
      const frames = decoder.push(frame);

      expect(frames).toHaveLength(1);
      expect(frames[0].body.length).toBe(MAX_BODY_BYTES);
    });

    // Mutation caught: not rejecting oversized body length (> 2 MiB) immediately upon reading 4 body-length bytes
    it('body 2 MiB + 1 throws too_large right after header and 4 body-length bytes', () => {
      const decoder = new FrameDecoder();
      const header = { t: 'test' };
      const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');

      const buf = Buffer.alloc(4 + headerBuf.length + 4);
      buf.writeUInt32BE(headerBuf.length, 0);
      headerBuf.copy(buf, 4);
      buf.writeUInt32BE(MAX_BODY_BYTES + 1, 4 + headerBuf.length);

      expect(() => decoder.push(buf)).toThrowError(
        expect.objectContaining({ code: 'too_large' })
      );
    });

    // Mutation caught: accepting non-object JSON header (like [1,2]) without throwing bad_frame
    it('header [1,2] (not an object) throws bad_frame', () => {
      const decoder = new FrameDecoder();
      const rawHeader = Buffer.from('[1,2]', 'utf8');
      const buf = Buffer.alloc(4 + rawHeader.length + 4);
      buf.writeUInt32BE(rawHeader.length, 0);
      rawHeader.copy(buf, 4);
      buf.writeUInt32BE(0, 4 + rawHeader.length);

      expect(() => decoder.push(buf)).toThrowError(
        expect.objectContaining({ code: 'bad_frame' })
      );
    });

    // Mutation caught: accepting invalid UTF-8 bytes in header without throwing bad_frame
    it('header with invalid UTF-8 throws bad_frame', () => {
      const decoder = new FrameDecoder();
      const badBytes = Buffer.from([0xff, 0xff, 0xff]);
      const buf = Buffer.alloc(4 + badBytes.length + 4);
      buf.writeUInt32BE(badBytes.length, 0);
      badBytes.copy(buf, 4);
      buf.writeUInt32BE(0, 4 + badBytes.length);

      expect(() => decoder.push(buf)).toThrowError(
        expect.objectContaining({ code: 'bad_frame' })
      );
    });

    // Mutation caught: encodeFrame failing to throw too_large when header or body exceeds limits
    it('encodeFrame refuses oversize parts', () => {
      const oversizeHeader = { pad: 'x'.repeat(MAX_HEADER_BYTES) };
      expect(() => encodeFrame(oversizeHeader)).toThrowError(
        expect.objectContaining({ code: 'too_large' })
      );

      const oversizeBody = Buffer.alloc(MAX_BODY_BYTES + 1);
      expect(() => encodeFrame({ t: 'ok' }, oversizeBody)).toThrowError(
        expect.objectContaining({ code: 'too_large' })
      );
    });

    // Mutation caught: decoder not staying in failed state after error
    it('the decoder stays failed after an error', () => {
      const decoder = new FrameDecoder();
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(MAX_HEADER_BYTES + 1, 0);

      expect(() => decoder.push(lenBuf)).toThrowError(
        expect.objectContaining({ code: 'too_large' })
      );

      const validFrame = encodeFrame({ ok: true });
      expect(() => decoder.push(validFrame)).toThrowError(
        expect.objectContaining({ code: 'too_large' })
      );
    });
  });

  describe('Transcript & Proofs', () => {
    // Mutation caught: incorrect transcript BE length framing or field order
    it('transcript exact bytes for ("srv", Buffer.from([1,2]), Buffer.alloc(0))', () => {
      const t = transcript('srv', Buffer.from([1, 2]), Buffer.alloc(0));
      const expected = Buffer.from([
        0, 0, 0, 3, 0x73, 0x72, 0x76,
        0, 0, 0, 2, 1, 2,
        0, 0, 0, 0,
      ]);
      expect(t).toEqual(expected);
    });

    // Mutation caught: incorrect HMAC calculation or field ordering for serverProof, clientProof, and enrollProof
    it('each proof equals independently computed HMAC-SHA256 with fixed key and nonces', () => {
      const key = Buffer.alloc(32, 0x42);
      const clientNonce = Buffer.alloc(32, 0x01);
      const serverNonce = Buffer.alloc(32, 0x02);

      const expectedSrvT = transcript('srv', clientNonce, serverNonce);
      const expectedSrvProof = crypto.createHmac('sha256', key).update(expectedSrvT).digest();
      expect(serverProof(key, clientNonce, serverNonce)).toEqual(expectedSrvProof);

      const expectedCliT = transcript('cli', serverNonce, clientNonce);
      const expectedCliProof = crypto.createHmac('sha256', key).update(expectedCliT).digest();
      expect(clientProof(key, serverNonce, clientNonce)).toEqual(expectedCliProof);

      const expectedEnrollT = transcript('enroll', serverNonce, clientNonce);
      const expectedEnrollProof = crypto.createHmac('sha256', key).update(expectedEnrollT).digest();
      expect(enrollProof(key, serverNonce, clientNonce)).toEqual(expectedEnrollProof);
    });
  });

  describe('Handshake Protocols', () => {
    // Mutation caught: happy-path handshake failure, mismatched sessionIds, or server decoder losing subsequent frames
    it('handshake success: matching sessionId and post-handshake frames delivered through decoder', async () => {
      const [clientStream, serverStream] = createDuplexPair();
      const key = crypto.randomBytes(32);
      const replay = new ReplayWindow();

      const [clientRes, serverRes] = await Promise.all([
        clientHandshake(clientStream, { key }),
        serverHandshake(serverStream, { key, replay }),
      ]);

      expect(clientRes.sessionId).toBe(serverRes.sessionId);
      expect(clientRes.sessionId).toMatch(/^[0-9a-f]{32}$/);
      expect(clientRes.clientNonce).toEqual(serverRes.clientNonce);
      expect(clientRes.serverNonce).toEqual(serverRes.serverNonce);

      const postFrame = encodeFrame({ t: 'post', action: 'ready' }, Buffer.from('payload'));
      clientStream.write(postFrame);

      const chunk = await new Promise<Buffer>((resolve) => serverStream.once('data', resolve));
      const decoded = serverRes.decoder.push(chunk);

      expect(decoded).toHaveLength(1);
      expect(decoded[0].header).toEqual({ t: 'post', action: 'ready' });
      expect(decoded[0].body).toEqual(Buffer.from('payload'));
    });

    // Mutation caught: server accepting a wrong client proof, not sending the auth_failed error frame, or leaving the stream alive.
    // With mismatched keys an honest client fails first (it verifies the server before proving itself), so this
    // uses a raw client that answers the challenge with a bogus proof.
    it('bad client proof: server rejects auth_failed, sends the error frame, destroys the stream', async () => {
      const [clientStream, serverStream] = createDuplexPair();
      const serverKey = Buffer.alloc(32, 1);
      const serverPromise = serverHandshake(serverStream, { key: serverKey, replay: new ReplayWindow() });

      const decoder = new FrameDecoder();
      const received: any[] = [];
      clientStream.on('data', (chunk: Buffer) => {
        for (const f of decoder.push(chunk)) received.push(f.header);
      });
      clientStream.write(encodeFrame({ t: 'hello', v: 1, clientNonce: Buffer.alloc(32, 7).toString('base64') }));
      for (let i = 0; i < 50 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
      expect(received[0]?.t).toBe('challenge');
      clientStream.write(encodeFrame({ t: 'proof', clientProof: Buffer.alloc(32, 9).toString('base64') }));

      await expect(serverPromise).rejects.toThrowError(expect.objectContaining({ code: 'auth_failed' }));
      for (let i = 0; i < 50 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 1));
      expect(received[1]).toEqual({ t: 'error', code: 'auth_failed' });
      expect(serverStream.destroyed).toBe(true);
    });

    // Mutation caught: an honest client proving itself to a server with a different key.
    it('mismatched keys: the client fails first and the server sees the stream close', async () => {
      const [clientStream, serverStream] = createDuplexPair();
      const clientPromise = clientHandshake(clientStream, { key: Buffer.alloc(32, 2) });
      const serverPromise = serverHandshake(serverStream, { key: Buffer.alloc(32, 1), replay: new ReplayWindow() });
      await expect(clientPromise).rejects.toThrowError(expect.objectContaining({ code: 'auth_failed' }));
      await expect(serverPromise).rejects.toThrow();
      expect(clientStream.destroyed).toBe(true);
    });

    // Mutation caught: client sending proof frame before validating server proof or accepting fake server challenge
    it('fake server with wrong key: client rejects auth_failed without writing proof frame', async () => {
      const [clientStream, serverStream] = createDuplexPair();
      const clientKey = Buffer.alloc(32, 1);
      const wrongServerKey = Buffer.alloc(32, 2);

      const writtenHeaders: any[] = [];
      const originalWrite = clientStream.write.bind(clientStream);
      clientStream.write = vi.fn((chunk: any, ...args: any[]) => {
        try {
          const decoder = new FrameDecoder();
          const frames = decoder.push(chunk);
          for (const f of frames) {
            writtenHeaders.push(f.header);
          }
        } catch (_) {}
        return (originalWrite as any)(chunk, ...args);
      });

      const clientPromise = clientHandshake(clientStream, { key: clientKey });
      const serverPromise = serverHandshake(serverStream, { key: wrongServerKey, replay: new ReplayWindow() });

      await expect(clientPromise).rejects.toThrowError(
        expect.objectContaining({ code: 'auth_failed' })
      );
      await serverPromise.catch(() => {});

      expect(writtenHeaders.some((h) => h.t === 'hello')).toBe(true);
      expect(writtenHeaders.some((h) => h.t === 'proof')).toBe(false);
      expect(clientStream.destroyed).toBe(true);
    });

    // Mutation caught: client accepting replayed server challenge bound to another clientNonce
    it('server replaying challenge from earlier connection: client rejects auth_failed', async () => {
      const [clientStream, serverStream] = createDuplexPair();
      const key = Buffer.alloc(32, 5);

      const clientPromise = clientHandshake(clientStream, { key });

      const decoder = new FrameDecoder();
      const chunk = await new Promise<Buffer>((resolve) => serverStream.once('data', resolve));
      const [helloFrame] = decoder.push(chunk);
      expect(helloFrame.header.t).toBe('hello');

      const oldClientNonce = Buffer.alloc(32, 0xee);
      const serverNonce = Buffer.alloc(32, 0xaa);
      const oldProof = serverProof(key, oldClientNonce, serverNonce);

      serverStream.write(encodeFrame({
        t: 'challenge',
        serverNonce: serverNonce.toString('base64'),
        serverProof: oldProof.toString('base64'),
      }));

      await expect(clientPromise).rejects.toThrowError(
        expect.objectContaining({ code: 'auth_failed' })
      );
      expect(clientStream.destroyed).toBe(true);
    });

    // Mutation caught: replay window allowing duplicate clientNonce within TTL
    it('replay: same clientNonce on second connection within 10 minutes rejects with replay', async () => {
      const key = Buffer.alloc(32, 7);
      const fixedNonce = Buffer.alloc(32, 9);
      const replay = new ReplayWindow();

      const [c1, s1] = createDuplexPair();
      await Promise.all([
        clientHandshake(c1, { key, randomBytes: () => fixedNonce }),
        serverHandshake(s1, { key, replay }),
      ]);

      const [c2, s2] = createDuplexPair();
      const c2Promise = clientHandshake(c2, { key, randomBytes: () => fixedNonce });
      const s2Promise = serverHandshake(s2, { key, replay });

      await expect(s2Promise).rejects.toThrowError(
        expect.objectContaining({ code: 'replay' })
      );
      await c2Promise.catch(() => {});
    });

    // Mutation caught: replay window not accepting nonce after TTL expiration
    it('replay: clientNonce accepted after 10 minutes TTL expiration', () => {
      let currentTime = 1_000_000;
      const replay = new ReplayWindow({ ttlMs: 600_000, now: () => currentTime });
      const nonce = Buffer.alloc(32, 1);

      expect(replay.checkAndRemember(nonce)).toBe(true);
      currentTime += 5 * 60 * 1000;
      expect(replay.checkAndRemember(nonce)).toBe(false);

      currentTime += 6 * 60 * 1000;
      expect(replay.checkAndRemember(nonce)).toBe(true);
    });

    // Mutation caught: replay window failing to evict oldest entry when capacity reached
    it('replay: window of max: 3 evicts the oldest entry', () => {
      const replay = new ReplayWindow({ max: 3 });
      const n1 = Buffer.alloc(32, 1);
      const n2 = Buffer.alloc(32, 2);
      const n3 = Buffer.alloc(32, 3);
      const n4 = Buffer.alloc(32, 4);

      expect(replay.checkAndRemember(n1)).toBe(true);
      expect(replay.checkAndRemember(n2)).toBe(true);
      expect(replay.checkAndRemember(n3)).toBe(true);

      expect(replay.checkAndRemember(n4)).toBe(true);

      // n4 evicted n1; re-adding n1 evicts n2. n3 and n4 are still remembered.
      expect(replay.checkAndRemember(n1)).toBe(true);
      expect(replay.checkAndRemember(n3)).toBe(false);
      expect(replay.checkAndRemember(n4)).toBe(false);
    });

    // Mutation caught: silent peer not triggering timeout, not destroying stream, or leaking listeners
    it('timeout: silent peer times out, stream destroyed, listener counts restored', async () => {
      vi.useFakeTimers();
      try {
        const [clientStream] = createDuplexPair();
        const initialListeners = clientStream.listenerCount('data');

        const key = Buffer.alloc(32, 8);
        const promise = clientHandshake(clientStream, { key, timeoutMs: 2000 });

        vi.advanceTimersByTime(2001);

        await expect(promise).rejects.toThrowError(
          expect.objectContaining({ code: 'timeout' })
        );

        expect(clientStream.destroyed).toBe(true);
        expect(clientStream.listenerCount('data')).toBe(initialListeners);
        expect(clientStream.listenerCount('error')).toBe(0);
        expect(clientStream.listenerCount('close')).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    // Mutation caught: accepting clientNonce not 32 bytes after base64 decoding
    it('unexpected message type or field types throws bad_frame', async () => {
      const [clientStream, serverStream] = createDuplexPair();
      const key = Buffer.alloc(32, 9);
      const serverPromise = serverHandshake(serverStream, { key, replay: new ReplayWindow() });

      clientStream.write(encodeFrame({
        t: 'hello',
        v: 1,
        clientNonce: Buffer.alloc(16).toString('base64'),
      }));

      await expect(serverPromise).rejects.toThrowError(
        expect.objectContaining({ code: 'bad_frame' })
      );
      expect(serverStream.destroyed).toBe(true);
    });
  });
});

describe('Packet P15b-1b: Codex security review fixes', () => {
  it('pipelining: server handoff preserves decoder state and returns pending frames when client pipelines frames', async () => {
    // Mutation: if serverHandshake corrupts decoder._buffer or drops pending frames, pipelined parsing fails with bad_frame
    const [serverStream, clientStream] = createDuplexPair();
    const key = crypto.randomBytes(32);
    const replay = new ReplayWindow();

    const serverPromise = serverHandshake(serverStream, { key, replay });

    const clientNonce = crypto.randomBytes(NONCE_BYTES);
    clientStream.write(encodeFrame({
      t: 'hello',
      v: 1,
      clientNonce: clientNonce.toString('base64'),
    }));

    const clientDecoder = new FrameDecoder();
    let challengeFrame: any = null;
    await new Promise<void>((resolve) => {
      const onData = (chunk: Buffer) => {
        const frames = clientDecoder.push(chunk);
        if (frames.length > 0) {
          challengeFrame = frames[0];
          clientStream.removeListener('data', onData);
          resolve();
        }
      };
      clientStream.on('data', onData);
    });

    expect(challengeFrame.header.t).toBe('challenge');
    const serverNonce = Buffer.from(challengeFrame.header.serverNonce, 'base64');
    const cProof = clientProof(key, serverNonce, clientNonce);

    const proofFrame = encodeFrame({
      t: 'proof',
      clientProof: cProof.toString('base64'),
    });
    const completeReq = encodeFrame({ t: 'req', id: 1 }, Buffer.from('payload-1'));
    const partialReqFull = encodeFrame({ t: 'req', id: 2 }, Buffer.from('payload-2'));
    const partialPart1 = partialReqFull.subarray(0, 6);
    const partialPart2 = partialReqFull.subarray(6);

    // Write proof + complete req + first 6 bytes of second req in one write
    clientStream.write(Buffer.concat([proofFrame, completeReq, partialPart1]));

    const serverRes = await serverPromise;

    expect(serverRes.pending).toHaveLength(1);
    expect(serverRes.pending[0].header).toEqual({ t: 'req', id: 1 });
    expect(serverRes.pending[0].body).toEqual(Buffer.from('payload-1'));

    const remainingFrames = serverRes.decoder.push(partialPart2);
    expect(remainingFrames).toHaveLength(1);
    expect(remainingFrames[0].header).toEqual({ t: 'req', id: 2 });
    expect(remainingFrames[0].body).toEqual(Buffer.from('payload-2'));
  });

  it('pipelining: client handoff preserves decoder state and returns pending frames when server pipelines frames', async () => {
    // Mutation: if clientHandshake corrupts decoder._buffer or drops pending frames, pipelined parsing fails with bad_frame
    const [serverStream, clientStream] = createDuplexPair();
    const key = crypto.randomBytes(32);

    const clientPromise = clientHandshake(clientStream, { key });

    const serverDecoder = new FrameDecoder();
    let helloFrame: any = null;
    await new Promise<void>((resolve) => {
      const onData = (chunk: Buffer) => {
        const frames = serverDecoder.push(chunk);
        if (frames.length > 0) {
          helloFrame = frames[0];
          serverStream.removeListener('data', onData);
          resolve();
        }
      };
      serverStream.on('data', onData);
    });

    expect(helloFrame.header.t).toBe('hello');
    const clientNonce = Buffer.from(helloFrame.header.clientNonce, 'base64');
    const serverNonce = crypto.randomBytes(NONCE_BYTES);
    const sProof = serverProof(key, clientNonce, serverNonce);

    serverStream.write(encodeFrame({
      t: 'challenge',
      serverNonce: serverNonce.toString('base64'),
      serverProof: sProof.toString('base64'),
    }));

    let proofFrame: any = null;
    await new Promise<void>((resolve) => {
      const onData = (chunk: Buffer) => {
        const frames = serverDecoder.push(chunk);
        if (frames.length > 0) {
          proofFrame = frames[0];
          serverStream.removeListener('data', onData);
          resolve();
        }
      };
      serverStream.on('data', onData);
    });

    expect(proofFrame.header.t).toBe('proof');

    const sessionId = crypto.randomBytes(16).toString('hex');
    const readyFrame = encodeFrame({ t: 'ready', sessionId });
    const completeRes = encodeFrame({ t: 'res', id: 10 }, Buffer.from('res-payload-1'));
    const partialResFull = encodeFrame({ t: 'res', id: 20 }, Buffer.from('res-payload-2'));
    const partialPart1 = partialResFull.subarray(0, 6);
    const partialPart2 = partialResFull.subarray(6);

    // Server writes ready + complete frame + partial frame in one write
    serverStream.write(Buffer.concat([readyFrame, completeRes, partialPart1]));

    const clientRes = await clientPromise;

    expect(clientRes.pending).toHaveLength(1);
    expect(clientRes.pending[0].header).toEqual({ t: 'res', id: 10 });
    expect(clientRes.pending[0].body).toEqual(Buffer.from('res-payload-1'));

    const remainingFrames = clientRes.decoder.push(partialPart2);
    expect(remainingFrames).toHaveLength(1);
    expect(remainingFrames[0].header).toEqual({ t: 'res', id: 20 });
    expect(remainingFrames[0].body).toEqual(Buffer.from('res-payload-2'));
  });

  it('serverHandshake requires a shared ReplayWindow instance and does not touch stream on failure', () => {
    // Mutation: if serverHandshake allows missing replay or throws asynchronously, this test fails
    const [serverStream] = createDuplexPair();
    const key = crypto.randomBytes(32);
    const writeSpy = vi.spyOn(serverStream, 'write');
    const destroySpy = vi.spyOn(serverStream, 'destroy');

    expect(() => {
      serverHandshake(serverStream, { key } as any);
    }).toThrow(TypeError);

    expect(() => {
      serverHandshake(serverStream, { key } as any);
    }).toThrow('serverHandshake requires a shared ReplayWindow');

    expect(() => {
      serverHandshake(serverStream, { key, replay: {} } as any);
    }).toThrow(TypeError);

    expect(writeSpy).not.toHaveBeenCalled();
    expect(destroySpy).not.toHaveBeenCalled();
    expect(serverStream.destroyed).toBe(false);
  });

  it('proof comparison calls crypto.timingSafeEqual for both server and client checks', async () => {
    // Mutation: if timingSafeEqualBuffers uses === or Buffer.prototype.equals, crypto.timingSafeEqual is not called
    const timingSpy = vi.spyOn(crypto, 'timingSafeEqual');
    try {
      const [serverStream, clientStream] = createDuplexPair();
      const key = crypto.randomBytes(32);
      const replay = new ReplayWindow();

      const [serverRes, clientRes] = await Promise.all([
        serverHandshake(serverStream, { key, replay }),
        clientHandshake(clientStream, { key }),
      ]);

      expect(serverRes.sessionId).toBe(clientRes.sessionId);
      expect(timingSpy).toHaveBeenCalledTimes(2);
      for (const call of timingSpy.mock.calls) {
        expect(call[0]).toBeInstanceOf(Buffer);
        expect(call[1]).toBeInstanceOf(Buffer);
        expect((call[0] as Buffer).length).toBe(32);
        expect((call[1] as Buffer).length).toBe(32);
      }
    } finally {
      timingSpy.mockRestore();
    }
  });

  it('server default deadline is exactly 5000ms when timeoutMs is omitted', async () => {
    // Mutation: if HANDSHAKE_TIMEOUT_MS or default timeoutMs changes from 5000, this test fails
    vi.useFakeTimers();
    try {
      const [serverStream] = createDuplexPair();
      const key = crypto.randomBytes(32);
      const replay = new ReplayWindow();

      let settled = false;
      let rejectError: any = null;

      const serverPromise = serverHandshake(serverStream, { key, replay }).catch((err: any) => {
        settled = true;
        rejectError = err;
      });

      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await serverPromise;

      expect(settled).toBe(true);
      expect(rejectError).toBeInstanceOf(BridgeError);
      expect(rejectError.code).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up stream listeners and timers after a successful handshake on both sides', async () => {
    // Mutation: if cleanup() fails to remove listeners or clear timer on success, this test fails
    vi.useFakeTimers();
    try {
      const [serverStream, clientStream] = createDuplexPair();
      const key = crypto.randomBytes(32);
      const replay = new ReplayWindow();

      const serverStartData = serverStream.listenerCount('data');
      const serverStartError = serverStream.listenerCount('error');
      const serverStartClose = serverStream.listenerCount('close');

      const clientStartData = clientStream.listenerCount('data');
      const clientStartError = clientStream.listenerCount('error');
      const clientStartClose = clientStream.listenerCount('close');

      const [serverRes, clientRes] = await Promise.all([
        serverHandshake(serverStream, { key, replay }),
        clientHandshake(clientStream, { key }),
      ]);

      expect(serverRes.sessionId).toBe(clientRes.sessionId);

      expect(serverStream.listenerCount('data')).toBe(serverStartData);
      expect(serverStream.listenerCount('error')).toBe(serverStartError);
      expect(serverStream.listenerCount('close')).toBe(serverStartClose);

      expect(clientStream.listenerCount('data')).toBe(clientStartData);
      expect(clientStream.listenerCount('error')).toBe(clientStartError);
      expect(clientStream.listenerCount('close')).toBe(clientStartClose);

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up stream listeners and timers after an auth failure on both sides', async () => {
    // Mutation: if cleanup() fails to remove listeners or clear timer on auth failure, this test fails
    vi.useFakeTimers();
    try {
      // 1. Server-side auth failure
      {
        const [serverStream, clientStream] = createDuplexPair();
        const key = crypto.randomBytes(32);
        const replay = new ReplayWindow();

        const sStartData = serverStream.listenerCount('data');
        const sStartError = serverStream.listenerCount('error');
        const sStartClose = serverStream.listenerCount('close');

        const serverPromise = serverHandshake(serverStream, { key, replay });

        const clientNonce = crypto.randomBytes(NONCE_BYTES);
        clientStream.write(encodeFrame({ t: 'hello', v: 1, clientNonce: clientNonce.toString('base64') }));

        const decoder = new FrameDecoder();
        await new Promise<void>((resolve) => {
          const onData = (chunk: Buffer) => {
            const frames = decoder.push(chunk);
            if (frames.length > 0) {
              clientStream.removeListener('data', onData);
              resolve();
            }
          };
          clientStream.on('data', onData);
        });

        const badProof = Buffer.alloc(32, 0xee).toString('base64');
        clientStream.write(encodeFrame({ t: 'proof', clientProof: badProof }));

        await expect(serverPromise).rejects.toThrow();

        expect(serverStream.listenerCount('data')).toBe(sStartData);
        expect(serverStream.listenerCount('error')).toBe(sStartError);
        expect(serverStream.listenerCount('close')).toBe(sStartClose);
        expect(vi.getTimerCount()).toBe(0);
      }

      // 2. Client-side auth failure
      {
        const [serverStream, clientStream] = createDuplexPair();
        const key = crypto.randomBytes(32);

        const cStartData = clientStream.listenerCount('data');
        const cStartError = clientStream.listenerCount('error');
        const cStartClose = clientStream.listenerCount('close');

        const clientPromise = clientHandshake(clientStream, { key });

        const sDecoder = new FrameDecoder();
        await new Promise<void>((resolve) => {
          const onData = (chunk: Buffer) => {
            const frames = sDecoder.push(chunk);
            if (frames.length > 0) {
              serverStream.removeListener('data', onData);
              resolve();
            }
          };
          serverStream.on('data', onData);
        });

        serverStream.write(encodeFrame({
          t: 'challenge',
          serverNonce: crypto.randomBytes(NONCE_BYTES).toString('base64'),
          serverProof: Buffer.alloc(32, 0xdd).toString('base64'),
        }));

        await expect(clientPromise).rejects.toThrow();

        expect(clientStream.listenerCount('data')).toBe(cStartData);
        expect(clientStream.listenerCount('error')).toBe(cStartError);
        expect(clientStream.listenerCount('close')).toBe(cStartClose);
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('client rejects challenge with 31-byte serverNonce with bad_frame and writes no proof', async () => {
    // Mutation: if clientHandshake does not check serverNonce length or writes proof before validation, this test fails
    const [serverStream, clientStream] = createDuplexPair();
    const key = crypto.randomBytes(32);

    const clientPromise = clientHandshake(clientStream, { key });

    const serverDecoder = new FrameDecoder();
    await new Promise<void>((resolve) => {
      const onData = (chunk: Buffer) => {
        const frames = serverDecoder.push(chunk);
        if (frames.length > 0) {
          serverStream.removeListener('data', onData);
          resolve();
        }
      };
      serverStream.on('data', onData);
    });

    let clientWroteAfterChallenge = false;
    serverStream.on('data', () => {
      clientWroteAfterChallenge = true;
    });

    const shortNonce = Buffer.alloc(31, 0x77);
    serverStream.write(encodeFrame({
      t: 'challenge',
      serverNonce: shortNonce.toString('base64'),
      serverProof: Buffer.alloc(32, 0x88).toString('base64'),
    }));

    let thrownError: any = null;
    try {
      await clientPromise;
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(BridgeError);
    expect(thrownError.code).toBe('bad_frame');
    expect(clientWroteAfterChallenge).toBe(false);
  });
});
