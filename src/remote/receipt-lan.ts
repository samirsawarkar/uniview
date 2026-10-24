// Reads files of the LAN-shared folder a receipt was opened from, through the same paired-computer
// connection the file browser and recents use.
import type { RemoteTransport } from "../core/types";
import type { HostRecord, RemoteEntry, RemoteHost } from "../../shared/remote-client.mjs";
import { LanNotFoundError, type LanReader } from "../core/receipt-resolve";
import { connect as defaultConnect } from "./connections";
import { loadHosts } from "./store";
import { remoteSource as defaultRemoteSource, type RemoteFileRef } from "./source";
import type { FileSource } from "../core/types";

export interface LanReaderDeps {
  transport?: RemoteTransport | null;
  hosts?: () => HostRecord[];
  connect?: (record: HostRecord, transport: RemoteTransport) => Promise<RemoteHost>;
  remoteSource?: (ref: RemoteFileRef) => FileSource;
}

/** The host answers these when the path or folder does not exist (or is not a file) on the share. */
const NOT_FOUND = /not available|no longer shared|not a file|not found|enoent/i;

export function isNotFoundMessage(message: string): boolean {
  return NOT_FOUND.test(message);
}

/**
 * A reader for one shared root of one paired computer, or null when this device cannot browse remote
 * folders. A computer that is no longer paired, or that cannot be reached, makes `open` reject with an
 * ordinary error (reported as `unreadable`); only an absent file is `LanNotFoundError` (`missing`).
 */
export function createLanReader(
  remote: { hostId: string; rootId: string; rootName?: string },
  deps: LanReaderDeps = {}
): LanReader | null {
  const transport = deps.transport;
  if (!transport) return null;
  const hostsFn = deps.hosts ?? loadHosts;
  const connectFn = deps.connect ?? defaultConnect;
  const sourceFn = deps.remoteSource ?? defaultRemoteSource;

  return {
    async open(path: string) {
      const record = hostsFn().find((h) => h.hostId === remote.hostId);
      if (!record) throw new Error("This computer is no longer paired.");
      const host = await connectFn(record, transport);
      let st: { size: number; mtime: number };
      try {
        st = await host.stat(remote.rootId, path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if ((err as { code?: string } | null)?.code === "host" && isNotFoundMessage(message)) {
          throw new LanNotFoundError(message);
        }
        throw err;
      }
      const entry: RemoteEntry = {
        name: path.split("/").pop() ?? path,
        dir: false,
        size: st.size,
        mtime: st.mtime,
      };
      const src = sourceFn({
        host,
        hostName: record.hostName,
        root: remote.rootId,
        rootName: remote.rootName,
        path,
        entry,
      });
      return {
        size: st.size,
        readAll: () => src.readAll(),
      };
    },
  };
}
