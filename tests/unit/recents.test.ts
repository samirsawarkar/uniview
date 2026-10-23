import { beforeEach, describe, expect, it } from "vitest";
import { loadRecents, rememberRecent, forgetRecent } from "../../src/ui/recents";

describe("recents", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stores and round-trips remote recents with all metadata", () => {
    const remote = {
      hostId: "host-1",
      rootId: "root-a",
      rootName: "Documents",
      path: "work/sheet.xlsx",
      mtime: 1700000000,
    };
    rememberRecent({ name: "sheet.xlsx", size: 1024, remote });
    const loaded = loadRecents();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.name).toBe("sheet.xlsx");
    expect(loaded[0]!.size).toBe(1024);
    expect(loaded[0]!.remote).toEqual(remote);
    expect(typeof loaded[0]!.openedAt).toBe("number");
  });

  it("de-duplicates remote recents by host+root+path", () => {
    const remote1 = {
      hostId: "host-1",
      rootId: "root-a",
      rootName: "Documents",
      path: "work/sheet.xlsx",
      mtime: 1700000000,
    };
    const remote1Updated = {
      ...remote1,
      mtime: 1700000099,
    };
    const remote2DiffPath = {
      ...remote1,
      path: "other/sheet.xlsx",
    };
    const remote3DiffRoot = {
      ...remote1,
      rootId: "root-b",
    };
    const remote4DiffHost = {
      ...remote1,
      hostId: "host-2",
    };

    rememberRecent({ name: "sheet.xlsx", size: 1024, remote: remote1 });
    rememberRecent({ name: "sheet.xlsx", size: 2048, remote: remote1Updated });

    let list = loadRecents();
    expect(list).toHaveLength(1);
    expect(list[0]!.size).toBe(2048);
    expect(list[0]!.remote?.mtime).toBe(1700000099);

    rememberRecent({ name: "sheet.xlsx", size: 1024, remote: remote2DiffPath });
    rememberRecent({ name: "sheet.xlsx", size: 1024, remote: remote3DiffRoot });
    rememberRecent({ name: "sheet.xlsx", size: 1024, remote: remote4DiffHost });

    list = loadRecents();
    expect(list).toHaveLength(4);
  });

  it("does not collide with local recents", () => {
    const remote = {
      hostId: "host-1",
      rootId: "root-a",
      rootName: "Documents",
      path: "report.pdf",
      mtime: 1700000000,
    };
    rememberRecent({ name: "report.pdf", size: 1000, path: "/home/user/report.pdf" });
    rememberRecent({ name: "report.pdf", size: 1000, remote });
    rememberRecent({ name: "report.pdf", size: 1000 }); // local file without path

    const list = loadRecents();
    expect(list).toHaveLength(3);

    // Forget the remote one only
    const remoteEntry = list.find((r) => r.remote)!;
    expect(remoteEntry).toBeDefined();
    forgetRecent(remoteEntry);

    const remaining = loadRecents();
    expect(remaining).toHaveLength(2);
    expect(remaining.some((r) => r.remote)).toBe(false);
  });
});
