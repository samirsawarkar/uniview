// Agents activity log (P17b): what agents asked UniView to do, kept for the Agents panel.
// Bounded as the spec says: at most 500 entries and 30 days; the oldest are dropped first.
// Plain Node ESM, no Electron imports: the clock and the persistence store are injected.
//
//   const log = createActivityLog({ store: createFileActivityStore({ dir }), now });
//   await log.load();                       // once at start
//   log.add({ type, sessionId?, client?, detail? });   // never throws, never awaits the disk
//   log.list();                             // oldest first
//   await log.flush();                      // resolves when everything added so far is saved
//
// Entries are { at: ISO time, type, sessionId?, client?, detail? }. `client` is an agent's self-reported name
// and `detail` free text; both are cleaned (control and bidi characters removed) and length-capped here.

import fsPromises from "node:fs/promises";
import path from "node:path";
import { cleanLabel, readJsonFile, writeFileAtomic } from "./agent-util.mjs";

export const ACTIVITY_LIMITS = Object.freeze({ max: 500, ttlDays: 30 });

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TYPE = 40;
const MAX_CLIENT = 80;
const MAX_DETAIL = 200;
const MAX_SESSION_ID = 64;

/** A well-formed stored entry (after cleaning), or null. */
function normalize(entry, atMs) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const type = cleanLabel(entry.type, MAX_TYPE);
  if (type === "") return null;
  const out = { at: new Date(atMs).toISOString(), type };
  const sessionId = cleanLabel(entry.sessionId, MAX_SESSION_ID);
  if (sessionId !== "") out.sessionId = sessionId;
  if (typeof entry.client === "string") out.client = cleanLabel(entry.client, MAX_CLIENT);
  if (typeof entry.detail === "string") out.detail = cleanLabel(entry.detail, MAX_DETAIL);
  return out;
}

/**
 * @param {{
 *   store: { load(): Promise<unknown[]>, save(entries: unknown[]): Promise<void> },
 *   now?: () => number,
 *   max?: number,
 *   ttlDays?: number
 * }} options
 */
export function createActivityLog({ store, now = Date.now, max = ACTIVITY_LIMITS.max, ttlDays = ACTIVITY_LIMITS.ttlDays }) {
  /** @type {Array<{ at: string, type: string, sessionId?: string, client?: string, detail?: string }>} */
  let entries = [];
  const ttlMs = ttlDays * DAY_MS;
  let dirty = false;
  let saving = null;

  function prune() {
    const cutoff = now() - ttlMs;
    // An entry exactly ttl old is kept; one millisecond older is dropped.
    entries = entries.filter((e) => Date.parse(e.at) >= cutoff);
    if (entries.length > max) entries = entries.slice(entries.length - max);
  }

  async function runSaves() {
    try {
      while (dirty) {
        dirty = false;
        try {
          await store.save(entries.map((e) => ({ ...e })));
        } catch {
          // Persistence is best effort: the in-memory log stays correct and the next add saves again.
        }
      }
    } finally {
      saving = null;
    }
  }

  return {
    limits: { max, ttlDays },

    async load() {
      let stored = [];
      try {
        stored = await store.load();
      } catch {
        stored = [];
      }
      const loaded = [];
      for (const raw of Array.isArray(stored) ? stored : []) {
        const at = raw && typeof raw === "object" ? Date.parse(raw.at) : NaN;
        if (!Number.isFinite(at)) continue;
        const entry = normalize(raw, at);
        if (entry) loaded.push(entry);
      }
      loaded.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      entries = loaded;
      prune();
    },

    add(entry) {
      const normalized = normalize(entry, now());
      if (!normalized) return;
      entries.push(normalized);
      prune();
      dirty = true;
      if (!saving) saving = runSaves();
    },

    list() {
      prune();
      return entries.map((e) => ({ ...e }));
    },

    flush() {
      return saving ?? Promise.resolve();
    },
  };
}

/** Persists the log as `<dir>/activity.json` (`{ v: 1, entries }`), written atomically and owner-only. */
export function createFileActivityStore({ dir, fs = fsPromises }) {
  const file = path.join(dir, "activity.json");
  return {
    async load() {
      const data = await readJsonFile(fs, file, null);
      return Array.isArray(data?.entries) ? data.entries : [];
    },
    async save(entries) {
      await fs.mkdir(dir, { recursive: true });
      await writeFileAtomic(fs, file, JSON.stringify({ v: 1, entries }));
    },
  };
}
