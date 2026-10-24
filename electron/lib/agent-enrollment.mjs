// Agent enrollment store (P17b): clients the person chose to "Always allow".
// Plain Node ESM, no Electron imports; the file system and clock are injected.
//
// Layout in <userData>/agents/ (the folder is created by this module; on Windows the wiring packet must give it
// the same owner-only ACL as <userData>/bridge, because Node's file mode is ignored there):
//   clients.json        { v: 1, clients: [{ clientId, name, enrolledAt }] }   no secrets
//   <clientId>.key      the client's 256-bit key as 64 hex characters (mode 0600)
//
// clientId = first 32 hex characters of SHA-256("uniview-agent-client\0" + cleaned self-reported name), so the
// MCP process (which reads the key file, same OS user) finds its key from its own name alone and enrolling the
// same name again replaces the key. The name is an untrusted label; the key is the secret that proves the client.
//
// Later sessions of an enrolled client send enroll = { clientId, proof } in mcp.hello where
// proof = base64(HMAC-SHA256(clientKey, T("enroll", serverNonce, clientNonce))) over that connection's
// handshake nonces (bridge-proto.mjs enrollProof). `verify` checks it in constant time. The registry is the
// authority: a key file without a record never verifies, so removing an enrollment is immediate.

import crypto from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { enrollProof } from "./bridge-proto.mjs";
import { cleanLabel, readJsonFile, writeFileAtomic } from "./agent-util.mjs";

export const ENROLLMENT_LIMITS = Object.freeze({ maxClients: 64, keyBytes: 32, maxNameLength: 80 });

const CLIENT_ID = /^[0-9a-f]{32}$/;
const KEY_HEX = /^[0-9a-f]{64}$/;

/** The stable client id for an agent name (see the header comment). */
export function clientIdForName(name) {
  const cleaned = cleanLabel(name, ENROLLMENT_LIMITS.maxNameLength);
  return crypto.createHash("sha256").update(`uniview-agent-client\0${cleaned}`).digest("hex").slice(0, 32);
}

function busyError() {
  return Object.assign(new Error("Too many enrolled agents"), { code: "busy" });
}

/** Key file text for a key and back; one place defines the format for both sides. */
export function formatKeyFile(key) {
  return `${Buffer.from(key).toString("hex")}\n`;
}

export function parseKeyFile(text) {
  const hex = typeof text === "string" ? text.trim() : "";
  return KEY_HEX.test(hex) ? Buffer.from(hex, "hex") : null;
}

/** Stores `<dir>/<clientId>.key` files (owner-only mode, written atomically). */
export function createFileKeyStore({ dir, fs = fsPromises }) {
  const fileFor = (clientId) => path.join(dir, `${clientId}.key`);
  return {
    async write(clientId, key) {
      if (!CLIENT_ID.test(clientId)) throw new TypeError("invalid client id");
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFileAtomic(fs, fileFor(clientId), formatKeyFile(key), { mode: 0o600 });
    },
    /** @returns {Promise<Buffer | null>} null when absent, unreadable or not a well-formed key */
    async read(clientId) {
      if (!CLIENT_ID.test(clientId)) return null;
      try {
        return parseKeyFile(await fs.readFile(fileFor(clientId), "utf8"));
      } catch {
        return null;
      }
    },
    async remove(clientId) {
      if (!CLIENT_ID.test(clientId)) return;
      try {
        await fs.unlink(fileFor(clientId));
      } catch {}
    },
  };
}

/**
 * The MCP process side: the key an enrolled agent of this name holds, or null when it was never enrolled.
 * @returns {Promise<{ clientId: string, key: Buffer } | null>}
 */
export async function readClientKey({ dir, name, fs = fsPromises }) {
  const clientId = clientIdForName(name);
  const key = await createFileKeyStore({ dir, fs }).read(clientId);
  return key ? { clientId, key } : null;
}

function validRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.clientId !== "string" || !CLIENT_ID.test(raw.clientId)) return null;
  if (typeof raw.name !== "string") return null;
  if (typeof raw.enrolledAt !== "string" || !Number.isFinite(Date.parse(raw.enrolledAt))) return null;
  return { clientId: raw.clientId, name: cleanLabel(raw.name, ENROLLMENT_LIMITS.maxNameLength), enrolledAt: raw.enrolledAt };
}

/**
 * @param {{
 *   dir: string,
 *   fs?: typeof import("node:fs/promises"),
 *   keyStore?: { write(id: string, key: Buffer): Promise<void>, read(id: string): Promise<Buffer | null>, remove(id: string): Promise<void> },
 *   now?: () => number,
 *   randomBytes?: (n: number) => Buffer,
 *   max?: number
 * }} options
 */
export function createEnrollmentStore({
  dir,
  fs = fsPromises,
  keyStore = createFileKeyStore({ dir, fs }),
  now = Date.now,
  randomBytes = crypto.randomBytes,
  max = ENROLLMENT_LIMITS.maxClients,
}) {
  const registryFile = path.join(dir, "clients.json");
  /** @type {Map<string, { clientId: string, name: string, enrolledAt: string }>} */
  let clients = new Map();
  let chain = Promise.resolve();

  /** Changes run one after another: each reads the registry the previous one wrote. */
  function serialize(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }

  async function saveRegistry(next) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(fs, registryFile, JSON.stringify({ v: 1, clients: [...next.values()] }), { mode: 0o600 });
  }

  return {
    limits: { maxClients: max },

    async load() {
      const data = await readJsonFile(fs, registryFile, null);
      const next = new Map();
      for (const raw of Array.isArray(data?.clients) ? data.clients : []) {
        const rec = validRecord(raw);
        if (rec && !next.has(rec.clientId) && next.size < max) next.set(rec.clientId, rec);
      }
      clients = next;
    },

    list() {
      return [...clients.values()].map((c) => ({ ...c }));
    },

    get(clientId) {
      const c = clients.get(clientId);
      return c ? { ...c } : undefined;
    },

    /**
     * Enrolls a client under its (cleaned) name with a fresh random key; enrolling an existing name replaces its
     * key. Rejects with code "busy" when `max` other clients are already enrolled.
     * @returns {Promise<{ clientId: string, name: string, enrolledAt: string }>}
     */
    enroll({ name }) {
      return serialize(async () => {
        const cleaned = cleanLabel(name, ENROLLMENT_LIMITS.maxNameLength);
        const clientId = clientIdForName(cleaned);
        const replacing = clients.has(clientId);
        if (!replacing && clients.size >= max) throw busyError();
        const record = { clientId, name: cleaned, enrolledAt: new Date(now()).toISOString() };
        await keyStore.write(clientId, randomBytes(ENROLLMENT_LIMITS.keyBytes));
        const next = new Map(clients);
        next.set(clientId, record);
        try {
          await saveRegistry(next);
        } catch (err) {
          // A new client must not leave a key behind that no record vouches for.
          if (!replacing) await keyStore.remove(clientId);
          throw err;
        }
        clients = next;
        return { ...record };
      });
    },

    /** Removes the record and the key file. @returns {Promise<boolean>} whether the client was enrolled */
    remove(clientId) {
      return serialize(async () => {
        if (!clients.has(clientId)) return false;
        const next = new Map(clients);
        next.delete(clientId);
        await saveRegistry(next);
        clients = next;
        await keyStore.remove(clientId);
        return true;
      });
    },

    /** True only for an enrolled client whose proof matches this connection's nonces. */
    async verify({ clientId, proof, serverNonce, clientNonce }) {
      try {
        if (typeof clientId !== "string" || !clients.has(clientId) || typeof proof !== "string") return false;
        const key = await keyStore.read(clientId);
        if (!key || key.length !== ENROLLMENT_LIMITS.keyBytes) return false;
        // A client removed while the key was being read must not pass.
        if (!clients.has(clientId)) return false;
        const expected = enrollProof(key, serverNonce, clientNonce);
        const given = Buffer.from(proof, "base64");
        return given.length === expected.length && crypto.timingSafeEqual(given, expected);
      } catch {
        return false;
      }
    },
  };
}
