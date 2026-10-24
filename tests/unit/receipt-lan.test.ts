import { describe, it, expect, vi } from "vitest";
import { createLanReader } from "../../src/remote/receipt-lan";
import { LanNotFoundError } from "../../src/core/receipt-resolve";
import { RemoteError } from "../../shared/remote-client.mjs";

const record: any = { hostId: "h1", hostName: "Work PC", hostPub: "x", port: 1 };
const transport: any = vi.fn();

function deps(stat: (root: string, path: string) => Promise<{ size: number; mtime: number }>) {
  const host: any = { stat: vi.fn(stat), record };
  const readAll = vi.fn(async () => new TextEncoder().encode("hello").buffer.slice(0) as ArrayBuffer);
  const remoteSource = vi.fn(() => ({ readAll }) as any);
  const connect = vi.fn(async () => host);
  return { host, readAll, remoteSource, connect, deps: { transport, hosts: () => [record], connect, remoteSource } as any };
}

describe("createLanReader", () => {
  it("is null where this device cannot browse remote folders", () => {
    // Mutation: building a reader without a transport (reads would throw late instead of 'unreadable' up front)
    expect(createLanReader({ hostId: "h1", rootId: "r" }, { transport: null })).toBeNull();
    expect(createLanReader({ hostId: "h1", rootId: "r" }, {})).toBeNull();
  });

  it("stats the path on the same host and root, then reads through the remote source", async () => {
    // Mutation: using another root or host, or skipping stat so the size limit cannot be checked first
    const d = deps(async () => ({ size: 5, mtime: 7 }));
    const reader = createLanReader({ hostId: "h1", rootId: "root-9", rootName: "Work" }, d.deps)!;
    const f = await reader.open("dir/a.txt");
    expect(f.size).toBe(5);
    expect(d.host.stat).toHaveBeenCalledWith("root-9", "dir/a.txt");
    expect(d.remoteSource).toHaveBeenCalledWith(
      expect.objectContaining({ root: "root-9", path: "dir/a.txt", entry: expect.objectContaining({ size: 5, mtime: 7, name: "a.txt" }) })
    );
    expect(d.readAll).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(await f.readAll())).toBe("hello");
  });

  it("maps the host's 'not available' answers to LanNotFoundError", async () => {
    // Mutation: reporting an absent file as unreadable
    for (const msg of ["That file or folder is not available.", "That shared folder is no longer shared.", "That is not a file."]) {
      const d = deps(async () => {
        throw new (RemoteError as any)(msg, "host");
      });
      const reader = createLanReader({ hostId: "h1", rootId: "r" }, d.deps)!;
      await expect(reader.open("x")).rejects.toBeInstanceOf(LanNotFoundError);
    }
  });

  it("keeps other failures as ordinary errors (unreadable), even if their text looks like 'not found'", async () => {
    // Mutation: classifying by message text alone, so an unreachable host looks like an absent file
    const unreachable = deps(async () => {
      throw new (RemoteError as any)("Work PC stopped responding. route not found", "unreachable");
    });
    const e1 = await createLanReader({ hostId: "h1", rootId: "r" }, unreachable.deps)!.open("x").catch((e) => e);
    expect(e1).toBeInstanceOf(Error);
    expect(e1).not.toBeInstanceOf(LanNotFoundError);
    const invalid = deps(async () => {
      throw new (RemoteError as any)("Invalid read.", "host");
    });
    const e2 = await createLanReader({ hostId: "h1", rootId: "r" }, invalid.deps)!.open("x").catch((e) => e);
    expect(e2).not.toBeInstanceOf(LanNotFoundError);
  });

  it("rejects (unreadable) when the computer is no longer paired", async () => {
    // Mutation: treating an unpaired computer as 'file missing'
    const d = deps(async () => ({ size: 1, mtime: 1 }));
    const reader = createLanReader({ hostId: "other", rootId: "r" }, d.deps)!;
    const e = await reader.open("x").catch((err) => err);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(LanNotFoundError);
    expect(d.connect).not.toHaveBeenCalled();
  });
});
