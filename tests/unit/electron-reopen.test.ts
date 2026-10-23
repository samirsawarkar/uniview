import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElectronBridge, type ElectronApi } from "../../src/shells/electron";

describe("Electron source reopen", () => {
  let disk: Uint8Array;
  let tokenCounter: number;
  let tokensCreated: string[];
  let fakeApi: ElectronApi;

  beforeEach(() => {
    tokenCounter = 0;
    tokensCreated = [];
    disk = new Uint8Array(10);
    for (let i = 0; i < 10; i++) {
      disk[i] = i;
    }

    fakeApi = {
      pickFiles: vi.fn(),
      openPath: vi.fn(async (path: string) => {
        tokenCounter++;
        const token = `token-${tokenCounter}`;
        tokensCreated.push(token);
        return {
          token,
          name: "test.txt",
          path,
          size: disk.length,
        };
      }),
      readRange: vi.fn(async (_token: string, start: number, end: number) => {
        const clampedEnd = Math.min(end, disk.length);
        const clampedStart = Math.min(start, clampedEnd);
        const slice = disk.subarray(clampedStart, clampedEnd);
        const copy = new Uint8Array(slice);
        return copy.buffer;
      }),
      reveal: vi.fn(),
      onOpenFiles: vi.fn(() => () => {}),
      ready: vi.fn(),
      thumbnail: vi.fn(async () => null),
      share: {} as any,
      remotePost: vi.fn(),
    };

    (window as any).uniview = fakeApi;
  });

  afterEach(() => {
    delete (window as any).uniview;
  });

  // Catches: reopen reusing the old size or token
  it("returns fresh source with current size and bytes after file grows", async () => {
    const bridge = createElectronBridge();
    const source = await bridge.openPath!("/path/to/test.txt");

    expect(source.size).toBe(10);
    const initialBytes = await source.readAll();
    expect(initialBytes.byteLength).toBe(10);
    expect(tokensCreated).toEqual(["token-1"]);

    // Grow the disk from 10 to 30 bytes
    const newDisk = new Uint8Array(30);
    newDisk.set(disk);
    for (let i = 10; i < 30; i++) {
      newDisk[i] = i;
    }
    disk = newDisk;

    // The original source's readAll returns 10 bytes (snapshot)
    const snapshotBytes = await source.readAll();
    expect(snapshotBytes.byteLength).toBe(10);

    expect(source.reopen).toBeDefined();
    if (!source.reopen) throw new Error("source.reopen must be defined");

    const reopened = await source.reopen();

    expect(reopened.size).toBe(30);
    expect(tokensCreated).toEqual(["token-1", "token-2"]);

    const reopenedBytes = await reopened.readAll();
    expect(reopenedBytes.byteLength).toBe(30);
    expect(new Uint8Array(reopenedBytes)).toEqual(disk);
  });
});
