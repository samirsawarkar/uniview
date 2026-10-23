// Client-side persistence for remote browsing: this device's identity and the computers it has paired with.
import { generateIdentity, type Identity } from "../../shared/remote-protocol.mjs";
import type { HostRecord } from "../../shared/remote-client.mjs";

const DB = "uniview-remote";
const HOSTS_KEY = "uniview.remote.hosts.v1";
const NAME_KEY = "uniview.remote.deviceName.v1";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("keys");
      req.result.createObjectStore("thumbs");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

let identity: Promise<Identity> | null = null;

/** This install's long-term key. The private half is a non-extractable CryptoKey that never leaves IndexedDB. */
export function getDeviceIdentity(): Promise<Identity> {
  identity ??= (async () => {
    const saved = await idb<Identity | undefined>("keys", "readonly", (s) => s.get("device")).catch(() => undefined);
    if (saved?.privateKey && saved.publicRaw) return saved;
    const created = await generateIdentity(false);
    await idb("keys", "readwrite", (s) => s.put(created, "device"));
    return created;
  })();
  return identity;
}

export function deviceName(): string {
  try {
    const saved = localStorage.getItem(NAME_KEY);
    if (saved) return saved;
  } catch {
    /* storage unavailable */
  }
  const ua = navigator.userAgent;
  const rawModel = /Android [\d.]+; ([^;)]+)/.exec(ua)?.[1];
  const model = rawModel?.replace(/\s*Build\/.*$/, "").trim();
  if (model && model !== "K") return model;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Mac/.test(ua)) return "Mac";
  return "UniView device";
}

export function setDeviceName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name.trim().slice(0, 64));
  } catch {
    /* storage unavailable */
  }
}

export function loadHosts(): HostRecord[] {
  try {
    const list = JSON.parse(localStorage.getItem(HOSTS_KEY) ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((h): h is HostRecord => typeof h?.hostId === "string" && typeof h?.hostPub === "string") : [];
  } catch {
    return [];
  }
}

function saveHosts(list: HostRecord[]): HostRecord[] {
  try {
    localStorage.setItem(HOSTS_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: pairing lasts for this session only */
  }
  return list;
}

export function rememberHost(record: HostRecord): HostRecord[] {
  return saveHosts([record, ...loadHosts().filter((h) => h.hostId !== record.hostId)]);
}

export function forgetHost(hostId: string): HostRecord[] {
  return saveHosts(loadHosts().filter((h) => h.hostId !== hostId));
}

// Thumbnails from remote computers, cached by path and modification time.
export async function cachedThumb(key: string): Promise<Blob | undefined> {
  return idb<Blob | undefined>("thumbs", "readonly", (s) => s.get(key)).catch(() => undefined);
}

export async function storeThumb(key: string, blob: Blob): Promise<void> {
  await idb("thumbs", "readwrite", (s) => s.put(blob, key)).catch(() => undefined);
}

export async function clearThumbs(): Promise<void> {
  await idb("thumbs", "readwrite", (s) => s.clear()).catch(() => undefined);
}
