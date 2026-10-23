import type { FileSource, RemoteTransport } from "../core/types";
import type { HostRecord, RemoteEntry, RemoteHost } from "../../shared/remote-client.mjs";
import type { Recent } from "../ui/recents";
import { connect as defaultConnect } from "./connections";
import { remoteSource as defaultRemoteSource, type RemoteFileRef } from "./source";

export type ConnectFn = (record: HostRecord, transport: RemoteTransport) => Promise<RemoteHost>;

export interface ReopenRemoteRecentOptions {
  hosts: HostRecord[];
  transport?: RemoteTransport | null;
  onNotice?: (message: string) => void;
  onOpen?: (source: FileSource) => void;
  connect?: ConnectFn;
  remoteSource?: (ref: RemoteFileRef) => FileSource;
}

export async function reopenRemoteRecent(
  recent: Recent,
  options: ReopenRemoteRecentOptions,
): Promise<FileSource | null> {
  if (!recent.remote) return null;

  const notify = options.onNotice ?? (() => {});
  const openCb = options.onOpen;
  const connectFn = options.connect ?? defaultConnect;
  const remoteSourceFn = options.remoteSource ?? defaultRemoteSource;

  if (!options.transport) {
    notify("Remote browsing is not supported on this device.");
    return null;
  }

  const hostId = recent.remote.hostId;
  const hostRecord = options.hosts.find((h) => h.hostId === hostId);
  if (!hostRecord) {
    notify(`Can't reach ${recent.name}: this computer is no longer paired.`);
    return null;
  }

  try {
    const host = await connectFn(hostRecord, options.transport);
    const st = await host.stat(recent.remote.rootId, recent.remote.path);
    if (st.mtime !== recent.remote.mtime || st.size !== recent.size) {
      notify(`"${recent.name}" on ${hostRecord.hostName} has changed since it was last opened.`);
      return null;
    }

    const entry: RemoteEntry = {
      name: recent.name,
      dir: false,
      size: st.size,
      mtime: st.mtime,
    };

    const source = remoteSourceFn({
      host,
      hostName: hostRecord.hostName,
      root: recent.remote.rootId,
      rootName: recent.remote.rootName,
      path: recent.remote.path,
      entry,
    });

    if (openCb) {
      openCb(source);
    }
    return source;
  } catch (err) {
    const msg = (err as Error).message || "";
    if (msg.includes("not available") || msg.includes("no longer shared") || /not found|enoent/i.test(msg)) {
      notify(`"${recent.name}" was removed from ${hostRecord.hostName}.`);
    } else {
      notify(`Can't reach ${hostRecord.hostName}: ${msg}`);
    }
    return null;
  }
}
