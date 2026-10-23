import { describe, expect, it, vi } from "vitest";
import { reopenRemoteRecent } from "../../src/remote/reopen-recent";
import type { HostRecord, RemoteHost } from "../../shared/remote-client.mjs";
import type { Recent } from "../../src/ui/recents";
import type { FileSource, RemoteTransport } from "../../src/core/types";

describe("reopenRemoteRecent", () => {
  const dummyHost: HostRecord = {
    hostId: "host-1",
    hostName: "Studio Mac",
    hostPub: "mock-pub-key",
    hosts: ["192.168.1.50"],
    port: 8443,
    deviceId: "device-1",
  };

  const dummyRemoteRecent: Recent = {
    name: "deck.pptx",
    size: 5000,
    openedAt: 1700000000,
    remote: {
      hostId: "host-1",
      rootId: "root-1",
      rootName: "Presentations",
      path: "deck.pptx",
      mtime: 1700000000,
    },
  };

  const dummyTransport: RemoteTransport = async () => ({
    status: 200,
    body: new Uint8Array(),
  });

  it("connects, stats, creates remoteSource and calls open callback on success", async () => {
    const stat = vi.fn().mockResolvedValue({ size: 5000, mtime: 1700000000 });
    const mockHost = {
      record: dummyHost,
      stat,
      read: vi.fn().mockResolvedValue(new Uint8Array()),
    } as unknown as RemoteHost;
    const connect = vi.fn().mockResolvedValue(mockHost);
    const onNotice = vi.fn();
    const onOpen = vi.fn();

    const result = await reopenRemoteRecent(dummyRemoteRecent, {
      hosts: [dummyHost],
      transport: dummyTransport,
      connect,
      onNotice,
      onOpen,
    });

    expect(connect).toHaveBeenCalledWith(dummyHost, dummyTransport);
    expect(stat).toHaveBeenCalledWith("root-1", "deck.pptx");
    expect(onNotice).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledTimes(1);
    const openedSource: FileSource = onOpen.mock.calls[0]![0];
    expect(openedSource.name).toBe("deck.pptx");
    expect(openedSource.size).toBe(5000);
    expect(openedSource.remote).toEqual({
      hostId: "host-1",
      rootId: "root-1",
      rootName: "Presentations",
      path: "deck.pptx",
      mtime: 1700000000,
    });
    expect(result).toBe(openedSource);
  });

  it("notifies and does not open when size changed", async () => {
    const stat = vi.fn().mockResolvedValue({ size: 9999, mtime: 1700000000 });
    const mockHost = { record: dummyHost, stat } as unknown as RemoteHost;
    const connect = vi.fn().mockResolvedValue(mockHost);
    const onNotice = vi.fn();
    const onOpen = vi.fn();

    const result = await reopenRemoteRecent(dummyRemoteRecent, {
      hosts: [dummyHost],
      transport: dummyTransport,
      connect,
      onNotice,
      onOpen,
    });

    expect(stat).toHaveBeenCalledWith("root-1", "deck.pptx");
    expect(onNotice).toHaveBeenCalledWith('"deck.pptx" on Studio Mac has changed since it was last opened.');
    expect(onOpen).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("notifies and does not open when mtime changed", async () => {
    const stat = vi.fn().mockResolvedValue({ size: 5000, mtime: 1700009999 });
    const mockHost = { record: dummyHost, stat } as unknown as RemoteHost;
    const connect = vi.fn().mockResolvedValue(mockHost);
    const onNotice = vi.fn();
    const onOpen = vi.fn();

    const result = await reopenRemoteRecent(dummyRemoteRecent, {
      hosts: [dummyHost],
      transport: dummyTransport,
      connect,
      onNotice,
      onOpen,
    });

    expect(stat).toHaveBeenCalledWith("root-1", "deck.pptx");
    expect(onNotice).toHaveBeenCalledWith('"deck.pptx" on Studio Mac has changed since it was last opened.');
    expect(onOpen).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("notifies appropriately when file is removed or not found", async () => {
    for (const errorMsg of ["file not found (ENOENT)", "path is not available", "folder is no longer shared"]) {
      const stat = vi.fn().mockRejectedValue(new Error(errorMsg));
      const mockHost = { record: dummyHost, stat } as unknown as RemoteHost;
      const connect = vi.fn().mockResolvedValue(mockHost);
      const onNotice = vi.fn();
      const onOpen = vi.fn();

      const result = await reopenRemoteRecent(dummyRemoteRecent, {
        hosts: [dummyHost],
        transport: dummyTransport,
        connect,
        onNotice,
        onOpen,
      });

      expect(onNotice).toHaveBeenCalledWith('"deck.pptx" was removed from Studio Mac.');
      expect(onOpen).not.toHaveBeenCalled();
      expect(result).toBeNull();
    }
  });

  it("notifies with host error message when host is unreachable or connection fails", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("Connection timed out"));
    const onNotice = vi.fn();
    const onOpen = vi.fn();

    const result = await reopenRemoteRecent(dummyRemoteRecent, {
      hosts: [dummyHost],
      transport: dummyTransport,
      connect,
      onNotice,
      onOpen,
    });

    expect(onNotice).toHaveBeenCalledWith("Can't reach Studio Mac: Connection timed out");
    expect(onOpen).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("notifies when host is missing / no longer paired", async () => {
    const connect = vi.fn();
    const onNotice = vi.fn();
    const onOpen = vi.fn();

    const result = await reopenRemoteRecent(dummyRemoteRecent, {
      hosts: [], // empty hosts list: host-1 not found
      transport: dummyTransport,
      connect,
      onNotice,
      onOpen,
    });

    expect(connect).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith("Can't reach deck.pptx: this computer is no longer paired.");
    expect(onOpen).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("notifies when remote transport is not supported / missing", async () => {
    const connect = vi.fn();
    const onNotice = vi.fn();
    const onOpen = vi.fn();

    const result = await reopenRemoteRecent(dummyRemoteRecent, {
      hosts: [dummyHost],
      transport: null,
      connect,
      onNotice,
      onOpen,
    });

    expect(connect).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith("Remote browsing is not supported on this device.");
    expect(onOpen).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("returns null when recent has no remote metadata", async () => {
    const localRecent: Recent = {
      name: "local.pdf",
      size: 1000,
      openedAt: Date.now(),
      path: "/home/user/local.pdf",
    };
    const connect = vi.fn();
    const onNotice = vi.fn();
    const onOpen = vi.fn();

    const result = await reopenRemoteRecent(localRecent, {
      hosts: [dummyHost],
      transport: dummyTransport,
      connect,
      onNotice,
      onOpen,
    });

    expect(connect).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
