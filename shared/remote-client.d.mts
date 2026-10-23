import type { Identity } from "./remote-protocol.mjs";
import type { RemoteTransport } from "../src/core/types";

export interface HostRecord {
  hostId: string;
  hostName: string;
  hostPub: string;
  hosts: string[];
  port: number;
  deviceId: string;
  preferred?: string;
}

export interface RemoteEntry {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
}

export class RemoteError extends Error {
  code: string;
}

export function pairWithOffer(offerText: string, opts: { transport: RemoteTransport; device: Identity; deviceName: string }): Promise<HostRecord>;

export class RemoteHost {
  constructor(record: HostRecord, opts: { transport: RemoteTransport; device: Identity; now?: () => number; onHostsChanged?: (record: HostRecord) => void });
  record: HostRecord;
  onHostsChanged?: (record: HostRecord) => void;
  info(): Promise<{ hostName: string; roots: { id: string; name: string }[] }>;
  list(root: string, path: string): Promise<RemoteEntry[]>;
  stat(root: string, path: string): Promise<{ size: number; mtime: number }>;
  read(root: string, path: string, start: number, end: number): Promise<Uint8Array>;
  thumb(root: string, path: string, size: number): Promise<Uint8Array>;
}

export function shouldRetryAfterTransportError(elapsedMs: number): boolean;

export function discoverHost(opts: {
  transport: RemoteTransport;
  hostId: string;
  hostPub: Uint8Array | string;
  knownHosts: readonly string[];
  port: number;
  timeoutMs?: number;
  concurrency?: number;
  deadlineMs?: number;
}): Promise<string | null>;
