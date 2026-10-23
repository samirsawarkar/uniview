import { RemoteHost, pairWithOffer, type HostRecord } from "../../shared/remote-client.mjs";
import type { RemoteTransport } from "../core/types";
import { deviceName, getDeviceIdentity, rememberHost } from "./store";

const live = new Map<string, RemoteHost>();

/** One RemoteHost (and so one encrypted session) per paired computer for the life of the app. */
export async function connect(record: HostRecord, transport: RemoteTransport): Promise<RemoteHost> {
  const hit = live.get(record.hostId);
  if (hit) return hit;
  const host = new RemoteHost(record, {
    transport,
    device: await getDeviceIdentity(),
    onHostsChanged: (r) => rememberHost(r),
  });
  live.set(record.hostId, host);
  return host;
}

export function disconnect(hostId: string): void {
  live.delete(hostId);
}

/** Pair with a computer from its QR/code text and remember it. */
export async function pair(offerText: string, transport: RemoteTransport): Promise<HostRecord> {
  const record = await pairWithOffer(offerText, { transport, device: await getDeviceIdentity(), deviceName: deviceName() });
  rememberHost(record);
  live.delete(record.hostId);
  return record;
}
