import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";

// @ts-expect-error plain ESM module without types
import { MAX_AGENT_PATH, MAX_AGENT_FILE_BYTES, checkPathString, createDriveClassifier, defaultDriveLookup, openAgentPath, AgentGrantStore } from "../../electron/lib/agent-paths.mjs";

describe("checkPathString", () => {
  it("accepts valid Windows and POSIX paths", () => {
    // Catches mutation: rejecting standard absolute file paths
    expect(checkPathString("C:\\Users\\a\\b.pdf", "win32")).toEqual({ ok: true });
    expect(checkPathString("c:/x/y.txt", "win32")).toEqual({ ok: true });
    expect(checkPathString("/home/a/b", "posix")).toEqual({ ok: true });
  });

  it("accepts paths of exactly MAX_AGENT_PATH (4096) characters", () => {
    // Catches mutation: off-by-one error rejecting valid 4096-char paths
    const win4096 = "C:\\" + "a".repeat(4093);
    expect(win4096.length).toBe(4096);
    expect(checkPathString(win4096, "win32")).toEqual({ ok: true });

    const posix4096 = "/" + "a".repeat(4095);
    expect(posix4096.length).toBe(4096);
    expect(checkPathString(posix4096, "posix")).toEqual({ ok: true });
  });

  it("rejects paths longer than 4096 characters", () => {
    // Catches mutation: allowing buffer-overflow-prone strings > 4096 chars
    const win4097 = "C:\\" + "a".repeat(4094);
    expect(win4097.length).toBe(4097);
    expect(checkPathString(win4097, "win32")).toEqual({
      ok: false,
      code: "bad_path",
      reason: expect.stringContaining("exceeds maximum length"),
    });

    const posix4097 = "/" + "a".repeat(4096);
    expect(posix4097.length).toBe(4097);
    expect(checkPathString(posix4097, "posix")).toEqual({
      ok: false,
      code: "bad_path",
      reason: expect.stringContaining("exceeds maximum length"),
    });
  });

  it("rejects non-strings and empty strings", () => {
    // Catches mutation: accepting undefined, null, or empty string inputs
    expect(checkPathString(undefined)).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
  });

  it("rejects control characters including NUL, BEL, and DEL", () => {
    // Catches mutation: accepting NUL bytes or terminal-injection control codes
    expect(checkPathString("C:\\a\\b\0c", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("C:\\a\\b\u0007c", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("C:\\a\\b\u007fc", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("/home/a\0b", "posix")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
  });

  it("rejects relative paths on both platforms", () => {
    // Catches mutation: allowing relative paths leading to cwd-dependent lookups
    expect(checkPathString("a\\b", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString(".\\a", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("..\\b", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("a/b", "posix")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("./a", "posix")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
  });

  it("rejects UNC paths and device prefixes before filesystem access", () => {
    // Catches mutation: allowing SMB/UNC network access or Windows namespace prefixes
    expect(checkPathString("\\\\server\\share\\a", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("//server/share/a", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("\\\\?\\C:\\a", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("\\\\.\\pipe\\x", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("//server/share/a", "posix")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
  });

  it("rejects Windows device names in any segment and allows safe look-alikes", () => {
    // Catches mutation: accepting DOS device names that freeze or corrupt Windows I/O
    expect(checkPathString("C:\\a\\CON", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("C:\\a\\nul.txt", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("C:\\a\\Com1 .", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("C:\\a\\LPT9.log", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("C:\\PRN\\doc.txt", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });

    // Allowed look-alikes must pass
    expect(checkPathString("C:\\a\\console.txt", "win32")).toEqual({ ok: true });
    expect(checkPathString("C:\\a\\COM10", "win32")).toEqual({ ok: true });
  });

  it("rejects alternate data streams (ADS) on Windows", () => {
    // Catches mutation: opening hidden NTFS alternate data streams
    expect(checkPathString("C:\\a\\file.txt:stream", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("C:\\a:b\\c", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
  });

  it("rejects POSIX virtual filesystems /dev, /proc, /sys and allows safe prefixes", () => {
    // Catches mutation: reading Linux kernel virtual filesystems or character devices
    expect(checkPathString("/dev/sda", "posix")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("/proc/1/mem", "posix")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("/sys/x", "posix")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("/dev", "posix")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });

    // Allowed look-alikes
    expect(checkPathString("/devices/x", "posix")).toEqual({ ok: true });
    expect(checkPathString("/procedures", "posix")).toEqual({ ok: true });
  });

  it("rejects cross-platform mismatches", () => {
    // Catches mutation: accepting POSIX paths on Windows or Windows paths on POSIX
    expect(checkPathString("/home/a/b", "win32")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
    expect(checkPathString("C:\\Users\\a\\b.pdf", "posix")).toEqual({ ok: false, code: "bad_path", reason: expect.any(String) });
  });
});

describe("createDriveClassifier", () => {
  it("allows DriveType 2 (removable) and 3 (fixed)", async () => {
    // Catches mutation: rejecting valid local fixed or removable drives
    const lookup = vi.fn(async (letter: string) => (letter === "C" ? 3 : 2));
    const classify = createDriveClassifier({ lookup });

    expect(await classify("C")).toBe("allowed");
    expect(await classify("D")).toBe("allowed");
  });

  it("rejects DriveType 4 (network), 5 (optical), null, and errors", async () => {
    // Catches mutation: allowing network shares or failing open on unknown drive types
    const lookup = vi.fn(async (letter: string) => {
      if (letter === "Z") return 4;
      if (letter === "E") return 5;
      if (letter === "X") throw new Error("CIM failure");
      return null;
    });
    const classify = createDriveClassifier({ lookup });

    expect(await classify("Z")).toBe("rejected");
    expect(await classify("E")).toBe("rejected");
    expect(await classify("X")).toBe("rejected");
    expect(await classify("Y")).toBe("rejected");
  });

  it("caches outcomes per upper-case letter for ttlMs", async () => {
    // Catches mutation: re-querying PowerShell on every path check or case sensitivity bug
    let currentTime = 1000;
    const lookup = vi.fn(async () => 3);
    const classify = createDriveClassifier({
      lookup,
      now: () => currentTime,
      ttlMs: 60_000,
    });

    // First call calls lookup
    expect(await classify("c")).toBe("allowed");
    expect(lookup).toHaveBeenCalledTimes(1);

    // Second call within 60s uses cache (case-insensitive)
    currentTime = 30_000;
    expect(await classify("C")).toBe("allowed");
    expect(lookup).toHaveBeenCalledTimes(1);

    // Call after 60s refreshes cache
    currentTime = 61_001;
    expect(await classify("C")).toBe("allowed");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("caches rejected outcomes for ttlMs", async () => {
    // Catches mutation: not caching rejections and hammering network queries
    let currentTime = 1000;
    const lookup = vi.fn(async () => 4);
    const classify = createDriveClassifier({
      lookup,
      now: () => currentTime,
      ttlMs: 60_000,
    });

    expect(await classify("Z")).toBe("rejected");
    expect(lookup).toHaveBeenCalledTimes(1);

    currentTime = 20_000;
    expect(await classify("z")).toBe("rejected");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("rejects when lookup times out", async () => {
    // Catches mutation: hanging indefinitely when DriveType query hangs
    vi.useFakeTimers();
    try {
      const neverLookup = () => new Promise<number | null>(() => {});
      const classify = createDriveClassifier({
        lookup: neverLookup,
        timeoutMs: 1000,
      });

      const classifyPromise = classify("C");
      await vi.advanceTimersByTimeAsync(1050);
      expect(await classifyPromise).toBe("rejected");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("defaultDriveLookup", () => {
  it("rejects malformed letters without running shell command", async () => {
    // Catches mutation: command injection vulnerability via unvalidated drive letters
    expect(await defaultDriveLookup("1")).toBeNull();
    expect(await defaultDriveLookup("C:")).toBeNull();
    expect(await defaultDriveLookup("")).toBeNull();
    expect(await defaultDriveLookup("CON")).toBeNull();
  });
});

describe("openAgentPath with real temp files", () => {
  let tempDirPath: string;

  beforeEach(async () => {
    tempDirPath = await mkdtemp(join(tmpdir(), "uniview-agent-paths-test-"));
  });

  afterEach(async () => {
    await rm(tempDirPath, { recursive: true, force: true });
  });

  it("opens a regular file and reports its size, dev and ino", async () => {
    // Catches mutation: failure to correctly read real filesystem attributes
    const testFile = join(tempDirPath, "test-file.txt");
    await writeFile(testFile, "agent content test", "utf8");

    const res = await openAgentPath(testFile, {
      platform: process.platform,
      classifyDrive: async () => "allowed",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.size).toBe(18);
      expect(typeof res.dev).toBe("bigint");
      expect(typeof res.ino).toBe("bigint");
      expect(res.handle).toBeDefined();
      await res.handle.close();
    }
  });

  it("rejects a directory with not_a_file", async () => {
    // Catches mutation: permitting directories to be opened as files on real filesystem
    const res = await openAgentPath(tempDirPath, {
      platform: process.platform,
      classifyDrive: async () => "allowed",
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("not_a_file");
  });

  it("rejects a missing file with not_found", async () => {
    // Catches mutation: misclassifying missing files as unreadable
    const missing = join(tempDirPath, "does-not-exist.txt");
    const res = await openAgentPath(missing, {
      platform: process.platform,
      classifyDrive: async () => "allowed",
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("not_found");
  });
});

describe("openAgentPath with injected fakes", () => {
  it("closes handle and returns bad_path when realpath resolves to a device path", async () => {
    // Catches mutation: symlink trickery bypassing device name check after open
    let closeCalls = 0;
    const mockHandle = {
      close: vi.fn(async () => { closeCalls++; }),
      stat: vi.fn(async () => ({ dev: 1n, ino: 1n, isFile: () => true, size: 100n })),
    };
    const mockFs = {
      open: vi.fn(async () => mockHandle),
      realpath: { native: vi.fn(async () => "C:\\safe\\nul.txt") },
      stat: vi.fn(async () => ({ dev: 1n, ino: 1n, isFile: () => true, size: 100n })),
    };

    const res = await openAgentPath("C:\\safe\\link.txt", {
      platform: "win32",
      fs: mockFs,
      classifyDrive: async () => "allowed",
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("bad_path");
    expect(closeCalls).toBe(1);
  });

  it("closes handle and returns changed when canonical stat and handle stat mismatch dev or ino", async () => {
    // Catches mutation: TOCTOU race where file was replaced between open and canonical stat
    let closeCalls = 0;
    const mockHandle = {
      close: vi.fn(async () => { closeCalls++; }),
      stat: vi.fn(async () => ({ dev: 1n, ino: 2n, isFile: () => true, size: 100n })),
    };
    const mockFs = {
      open: vi.fn(async () => mockHandle),
      realpath: { native: vi.fn(async (p) => p) },
      stat: vi.fn(async () => ({ dev: 1n, ino: 999n, isFile: () => true, size: 100n })),
    };

    const res = await openAgentPath("C:\\safe\\file.txt", {
      platform: "win32",
      fs: mockFs,
      classifyDrive: async () => "allowed",
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("changed");
    expect(closeCalls).toBe(1);
  });

  it("closes handle and returns too_large when file size exceeds 4 GiB", async () => {
    // Catches mutation: accepting files larger than MAX_AGENT_FILE_BYTES (4 GiB)
    let closeCalls = 0;
    const mockHandle = {
      close: vi.fn(async () => { closeCalls++; }),
      stat: vi.fn(async () => ({ dev: 1n, ino: 1n, isFile: () => true, size: BigInt(MAX_AGENT_FILE_BYTES) + 1n })),
    };
    const mockFs = {
      open: vi.fn(async () => mockHandle),
      realpath: { native: vi.fn(async (p) => p) },
      stat: vi.fn(async () => ({ dev: 1n, ino: 1n, isFile: () => true, size: BigInt(MAX_AGENT_FILE_BYTES) + 1n })),
    };

    const res = await openAgentPath("C:\\safe\\big.bin", {
      platform: "win32",
      fs: mockFs,
      classifyDrive: async () => "allowed",
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("too_large");
    expect(closeCalls).toBe(1);
  });

  it("accepts a file of exactly 4 GiB", async () => {
    // Catches mutation: off-by-one boundary check rejecting exactly 4 GiB
    let closeCalls = 0;
    const mockHandle = {
      close: vi.fn(async () => { closeCalls++; }),
      stat: vi.fn(async () => ({ dev: 1n, ino: 1n, isFile: () => true, size: BigInt(MAX_AGENT_FILE_BYTES) })),
    };
    const mockFs = {
      open: vi.fn(async () => mockHandle),
      realpath: { native: vi.fn(async (p) => p) },
      stat: vi.fn(async () => ({ dev: 1n, ino: 1n, isFile: () => true, size: BigInt(MAX_AGENT_FILE_BYTES) })),
    };

    const res = await openAgentPath("C:\\safe\\exact.bin", {
      platform: "win32",
      fs: mockFs,
      classifyDrive: async () => "allowed",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.size).toBe(MAX_AGENT_FILE_BYTES);
      expect(closeCalls).toBe(0);
      await res.handle.close();
      expect(closeCalls).toBe(1);
    }
  });

  it("never calls open if classifyDrive rejects drive letter", async () => {
    // Catches mutation: opening network drive files prior to classification verification
    const openFn = vi.fn();
    const mockFs = {
      open: openFn,
      realpath: { native: vi.fn() },
      stat: vi.fn(),
    };
    const res = await openAgentPath("Z:\\shared\\doc.txt", {
      platform: "win32",
      fs: mockFs,
      classifyDrive: async () => "rejected",
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("network_drive");
    expect(openFn).not.toHaveBeenCalled();
  });

  it("classifies canonical drive if different from initial drive on win32", async () => {
    // Catches mutation: bypassing network drive rejection via cross-drive symlinks
    let closeCalls = 0;
    const mockHandle = {
      close: vi.fn(async () => { closeCalls++; }),
      stat: vi.fn(async () => ({ dev: 1n, ino: 1n, isFile: () => true, size: 100n })),
    };
    const classifyCalls: string[] = [];
    const classifyDrive = async (letter: string) => {
      classifyCalls.push(letter.toUpperCase());
      return letter.toUpperCase() === "C" ? "allowed" : "rejected";
    };
    const mockFs = {
      open: vi.fn(async () => mockHandle),
      realpath: { native: vi.fn(async () => "D:\\remote\\target.txt") },
      stat: vi.fn(async () => ({ dev: 1n, ino: 1n, isFile: () => true, size: 100n })),
    };

    const res = await openAgentPath("C:\\local\\symlink.txt", {
      platform: "win32",
      fs: mockFs,
      classifyDrive,
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("network_drive");
    expect(classifyCalls).toEqual(["C", "D"]);
    expect(closeCalls).toBe(1);
  });

  it("closes handle when slow open resolves after timeout expiration", async () => {
    // Catches mutation: handle leak when open resolves after timeout fires
    let closeCalls = 0;
    const mockHandle = {
      close: vi.fn(async () => { closeCalls++; }),
      stat: vi.fn(async () => ({ dev: 1n, ino: 1n, isFile: () => true, size: 100n })),
    };

    let resolveOpen: (h: any) => void;
    const slowOpenPromise = new Promise((resolve) => {
      resolveOpen = resolve;
    });

    const mockFs = {
      open: vi.fn(() => slowOpenPromise),
      realpath: { native: vi.fn(async (p) => p) },
      stat: vi.fn(async () => ({ dev: 1n, ino: 1n, isFile: () => true, size: 100n })),
    };

    const openPromise = openAgentPath("C:\\safe\\file.txt", {
      platform: "win32",
      fs: mockFs,
      classifyDrive: async () => "allowed",
      timeoutMs: 50,
    });

    const res = await openPromise;
    expect(res.ok).toBe(false);
    expect(res.code).toBe("unreadable");
    expect(closeCalls).toBe(0);

    // Resolve the delayed open; handle must be closed immediately
    resolveOpen!(mockHandle);
    await new Promise((r) => setTimeout(r, 10));

    expect(closeCalls).toBe(1);
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it("closes handle exactly once on unexpected stat failure", async () => {
    // Catches mutation: handle leak when stat throws unexpected error
    let closeCalls = 0;
    const mockHandle = {
      close: vi.fn(async () => { closeCalls++; }),
      stat: vi.fn(async () => { throw new Error("I/O failure"); }),
    };
    const mockFs = {
      open: vi.fn(async () => mockHandle),
      realpath: { native: vi.fn(async (p) => p) },
      stat: vi.fn(async () => ({ dev: 1n, ino: 1n, isFile: () => true, size: 100n })),
    };

    const res = await openAgentPath("C:\\safe\\file.txt", {
      platform: "win32",
      fs: mockFs,
      classifyDrive: async () => "allowed",
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("unreadable");
    expect(closeCalls).toBe(1);
  });
});

describe("AgentGrantStore", () => {
  it("issues unguessable 32-hex tokens that are unique per grant", () => {
    // Catches mutation: predictable or improperly formatted tokens
    const store = new AgentGrantStore();
    const scopeId = store.openScope();
    expect(scopeId).toMatch(/^[0-9a-f]{32}$/);

    const token1 = store.grant(scopeId, { handle: {}, canonical: "/a/b.txt", size: 10 });
    const token2 = store.grant(scopeId, { handle: {}, canonical: "/a/b.txt", size: 10 });
    expect(token1).toMatch(/^[0-9a-f]{32}$/);
    expect(token2).toMatch(/^[0-9a-f]{32}$/);
    expect(token1).not.toBe(token2);
  });

  it("get returns grant entry for valid tokens and undefined for junk", () => {
    // Catches mutation: path traversal or arbitrary string injection via token parameter
    const store = new AgentGrantStore();
    const scopeId = store.openScope();
    const dummyHandle = {};
    const token = store.grant(scopeId, { handle: dummyHandle, canonical: "/data/img.png", size: 42 });

    expect(store.get(token)).toEqual({
      handle: dummyHandle,
      canonical: "/data/img.png",
      size: 42,
      scopeId,
    });

    expect(store.get("")).toBeUndefined();
    expect(store.get("invalid-token")).toBeUndefined();
    expect(store.get("../../etc/passwd")).toBeUndefined();
    expect(store.get("a".repeat(31))).toBeUndefined();
    expect(store.get("a".repeat(33))).toBeUndefined();
    expect(store.get(null)).toBeUndefined();
  });

  it("inScope returns true only within matching scope and false across scopes", () => {
    // Catches mutation: cross-view grant leakage across different scopes
    const store = new AgentGrantStore();
    const scope1 = store.openScope();
    const scope2 = store.openScope();

    const token1 = store.grant(scope1, { handle: {}, canonical: "/f1.txt", size: 10 });
    expect(store.inScope(token1, scope1)).toBe(true);
    expect(store.inScope(token1, scope2)).toBe(false);
    expect(store.inScope("unknown", scope1)).toBe(false);
  });

  it("closeScope closes each handle once and is idempotent", async () => {
    // Catches mutation: double closing handles or handle leak on scope disposal
    const store = new AgentGrantStore();
    const scopeId = store.openScope();

    let closeCount = 0;
    const mockHandle = {
      close: vi.fn(async () => { closeCount++; }),
    };

    const token = store.grant(scopeId, { handle: mockHandle, canonical: "/f.txt", size: 10 });

    await store.closeScope(scopeId);
    expect(closeCount).toBe(1);
    expect(store.get(token)).toBeUndefined();
    expect(store.inScope(token, scopeId)).toBe(false);

    // Calling closeScope a second time is harmless and does not re-close handle
    await store.closeScope(scopeId);
    expect(closeCount).toBe(1);
  });

  it("grant throws on unknown or closed scope", async () => {
    // Catches mutation: granting handles to closed scopes
    const store = new AgentGrantStore();
    const scopeId = store.openScope();
    await store.closeScope(scopeId);

    expect(() => store.grant(scopeId, { handle: {}, canonical: "/f.txt", size: 10 })).toThrow();
    expect(() => store.grant("nonexistent-scope", { handle: {}, canonical: "/f.txt", size: 10 })).toThrow();
  });

  it("closeAll closes all scopes and handles", async () => {
    // Catches mutation: leaking handles on application close / closeAll
    const store = new AgentGrantStore();
    const s1 = store.openScope();
    const s2 = store.openScope();

    let h1Closed = 0;
    let h2Closed = 0;
    const h1 = { close: vi.fn(async () => { h1Closed++; }) };
    const h2 = { close: vi.fn(async () => { h2Closed++; }) };

    const t1 = store.grant(s1, { handle: h1, canonical: "/1.txt", size: 1 });
    const t2 = store.grant(s2, { handle: h2, canonical: "/2.txt", size: 2 });

    await store.closeAll();

    expect(h1Closed).toBe(1);
    expect(h2Closed).toBe(1);
    expect(store.get(t1)).toBeUndefined();
    expect(store.get(t2)).toBeUndefined();
  });
});

describe("P15a-2 hardening", () => {
  const rejectedDevices = [
    "C:\\CON",
    "C:\\prn",
    "C:\\AUX",
    "C:\\NUL",
    "C:\\COM1",
    "C:\\com9",
    "C:\\LPT1",
    "C:\\lpt9",
    "C:\\path\\CON.txt",
    "C:\\path\\nul.dat",
    "C:\\path\\aux   ",
    // Hardening P15a-2 additions:
    "C:\\CONIN$",
    "C:\\conin$",
    "C:\\path\\CONIN$.txt",
    "C:\\path\\CONIN$ ",
    "C:\\CONOUT$",
    "C:\\conout$",
    "C:\\path\\CONOUT$.log",
    "C:\\path\\CONOUT$   ",
    "C:\\COM¹",
    "C:\\com¹",
    "C:\\path\\COM¹.txt",
    "C:\\COM²",
    "C:\\com²",
    "C:\\path\\COM².dat",
    "C:\\COM³",
    "C:\\com³",
    "C:\\path\\COM³.log",
    "C:\\LPT¹",
    "C:\\lpt¹",
    "C:\\path\\LPT¹.txt",
    "C:\\LPT²",
    "C:\\lpt²",
    "C:\\path\\LPT².dat",
    "C:\\LPT³",
    "C:\\lpt³",
    "C:\\path\\LPT³.log",
  ];

  it.each(rejectedDevices)(
    "rejects Windows device name in path: %s",
    (badPath) => {
      // Catches mutation: allowing Windows device names in win32 path segments
      const res = checkPathString(badPath, "win32");
      expect(res.ok).toBe(false);
      expect(res.code).toBe("bad_path");
    }
  );

  const allowedLookAlikes = [
    "C:\\safe\\file.txt",
    "C:\\safe\\COM10",
    "C:\\safe\\com10.txt",
    "C:\\safe\\console.txt",
    "C:\\safe\\CONIN.txt",
    "C:\\safe\\conin.dat",
    "C:\\safe\\CONOUT.txt",
    "C:\\safe\\conout.log",
    "C:\\safe\\LPT10",
    "C:\\safe\\lpt10.txt",
  ];

  it.each(allowedLookAlikes)(
    "accepts look-alike and safe paths: %s",
    (goodPath) => {
      // Catches mutation: over-eager rejection of device look-alikes like COM10 or CONIN.txt
      const res = checkPathString(goodPath, "win32");
      expect(res.ok).toBe(true);
    }
  );

  it("opens with O_RDONLY|O_NONBLOCK|O_NOCTTY on POSIX and with 'r' on win32", async () => {
    // Catches mutation: opening special files without the non-blocking flags on POSIX (the constants are
    // injected through the fake fs, so this also fails on Windows hosts where Node does not define them).
    const flags = { O_RDONLY: 0, O_NONBLOCK: 0o4000, O_NOCTTY: 0o400 };
    const mockHandle = {
      close: vi.fn(async () => {}),
      stat: vi.fn(async () => ({ dev: 1n, ino: 1n, isFile: () => true, size: 10n })),
    };
    const fakeFs = (canonical: string) => ({
      constants: flags,
      open: vi.fn(async () => mockHandle),
      realpath: { native: vi.fn(async () => canonical) },
      stat: vi.fn(async () => ({ dev: 1n, ino: 1n, isFile: () => true, size: 10n })),
    });
    const linuxFs = fakeFs("/safe/file.txt");
    await openAgentPath("/safe/file.txt", { platform: "linux", fs: linuxFs, classifyDrive: async () => "allowed" });
    expect(linuxFs.open).toHaveBeenCalledWith("/safe/file.txt", flags.O_RDONLY | flags.O_NONBLOCK | flags.O_NOCTTY);

    const winFs = fakeFs("C:\\safe\\file.txt");
    await openAgentPath("C:\\safe\\file.txt", { platform: "win32", fs: winFs, classifyDrive: async () => "allowed" });
    expect(winFs.open).toHaveBeenCalledWith("C:\\safe\\file.txt", "r");
  });

  it("rejects a FIFO without blocking and returns not_a_file within 1 s (POSIX hosts)", async () => {
    // Catches mutation: a blocking open of a named pipe before validation.
    if (process.platform === "win32") return;
    const dir = await mkdtemp(join(tmpdir(), "uniview-fifo-"));
    const fifo = join(dir, "pipe");
    try {
      try {
        execFileSync("mkfifo", [fifo]);
      } catch {
        return; // mkfifo unavailable on this host
      }
      const start = Date.now();
      const res = await openAgentPath(fifo, { classifyDrive: async () => "allowed", timeoutMs: 5000 });
      expect(Date.now() - start).toBeLessThan(1000);
      expect(res).toMatchObject({ ok: false, code: "not_a_file" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
