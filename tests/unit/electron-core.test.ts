import { describe, expect, it, vi } from "vitest";
import { resolve, sep } from "node:path";
// @ts-expect-error plain ESM module without types
import { parseRange, GrantStore, safeJoin, filesFromArgv, contentType, isAllowedUrl, checkReadArgs, isAppFrame, isLanHost, canDecodeThumbnailFallback, makeThumbnailPng } from "../../electron/lib/core.mjs";

describe("parseRange", () => {
  it("handles open, closed, suffix and clamped ranges", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });
  it("ignores malformed and multi-range headers, rejects unsatisfiable ones", () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 10)).toBeNull();
    expect(parseRange("items=0-1", 10)).toBeNull();
    expect(parseRange("bytes=20-30", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-2", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
  });
});

describe("GrantStore", () => {
  it("issues unguessable tokens, reuses them per path, rejects junk", () => {
    const g = new GrantStore();
    const t = g.grant("/a/b.pdf", 10);
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(g.grant("/a/b.pdf", 12)).toBe(t);
    expect(g.get(t)).toMatchObject({ path: "/a/b.pdf", size: 12 });
    expect(g.get("../../etc/passwd")).toBeUndefined();
    expect(g.get("0".repeat(32))).toBeUndefined();
    expect(g.get(42)).toBeUndefined();
  });
});

describe("safeJoin", () => {
  const root = resolve("dist");
  it("resolves files inside the root", () => {
    expect(safeJoin(root, "/index.html")).toBe(resolve(root, "index.html"));
    expect(safeJoin(root, "/assets/a%20b.js")).toBe(resolve(root, "assets", "a b.js"));
  });
  it("refuses traversal, encoded traversal, absolute paths and NUL", () => {
    expect(safeJoin(root, "/../package.json")).toBeNull();
    expect(safeJoin(root, "/%2e%2e/%2e%2e/secret")).toBeNull();
    expect(safeJoin(root, "/..%5c..%5cwindows")).toBeNull();
    expect(safeJoin(root, "/a%00.js")).toBeNull();
    expect(safeJoin(root, "/%E0%A4%A")).toBeNull();
    const r = safeJoin(root, "/assets/../index.html");
    expect(r === null || r.startsWith(root + sep)).toBe(true);
  });
});

describe("filesFromArgv", () => {
  it("keeps absolute paths and drops flags and the app path", () => {
    const abs = resolve("x.pdf");
    expect(filesFromArgv(["UniView.exe", "--flag", abs], true)).toEqual([abs]);
    expect(filesFromArgv(["electron.exe", ".", abs, "relative.txt"], false)).toEqual([abs]);
  });
});

describe("misc", () => {
  it("maps content types and allow-lists URL schemes", () => {
    expect(contentType("a/B.SVG")).toBe("image/svg+xml");
    expect(contentType("x.unknown")).toBe("application/octet-stream");
    expect(isAllowedUrl("uniview://app/index.html")).toBe(true);
    expect(isAllowedUrl("blob:uniview://app/123")).toBe(true);
    expect(isAllowedUrl("https://example.com")).toBe(false);
    expect(isAllowedUrl("file:///C:/secret.txt")).toBe(false);
    expect(isAllowedUrl("ws://localhost:1")).toBe(false);
  });
  it("validates read ranges", () => {
    expect(checkReadArgs(0, 10, 100, 1000)).toBeNull();
    expect(checkReadArgs(-1, 10, 100, 1000)).toBe("invalid range");
    expect(checkReadArgs(0, 2000, 3000, 1000)).toMatch(/limited/);
    expect(checkReadArgs(500, 600, 100, 1000)).toMatch(/past the end/);
    expect(checkReadArgs(0.5, 1, 100, 1000)).toBe("invalid range");
  });
});

describe("isAppFrame (IPC sender validation)", () => {
  it("accepts only the app's top-level page", () => {
    const top: { url: string; top?: unknown } = { url: "uniview://app/index.html" };
    top.top = top;
    expect(isAppFrame(top)).toBe(true);
    const sub = { url: "uniview://app/index.html", top };
    expect(isAppFrame(sub)).toBe(false);
    const foreign: { url: string; top?: unknown } = { url: "https://evil.example/" };
    foreign.top = foreign;
    expect(isAppFrame(foreign)).toBe(false);
    const blob: { url: string; top?: unknown } = { url: "blob:uniview://app/123" };
    blob.top = blob;
    expect(isAppFrame(blob)).toBe(false);
    expect(isAppFrame(null)).toBe(false);
    expect(isAppFrame(undefined)).toBe(false);
  });
});

describe("isLanHost (remote client transport)", () => {
  it("allows only local-network addresses", () => {
    for (const h of ["192.168.1.5", "10.0.0.2", "172.16.4.1", "172.31.255.255", "127.0.0.1", "::1", "fd12:3456::1", "fe80::1", "[fd12::1]", "fd00::1", "FE80::1"]) {
      expect(isLanHost(h)).toBe(true);
    }
    for (const h of ["8.8.8.8", "172.32.0.1", "192.169.1.1", "example.com", "evil.local.example.com", "2001:4860::8888", "256.1.1.1", "", "localhost", "169.254.3.3", "100.64.1.1", "studio-pc.local", "010.0.0.1", "192.168.01.1", "fe80::1%eth0", "user@192.168.1.5", " 192.168.1.5", "192.168.1.5 ", "[fe80::1", "fc00:evil.com", "fd00:not-an-ip", "::ffff:8.8.8.8", "fe80::zz"]) {
      expect(isLanHost(h)).toBe(false);
    }
  });
});


describe("canDecodeThumbnailFallback", () => {
  // Mutation: fails to accept valid lowercase image under 20 MiB
  it("returns true for a.png 1 KB", () => {
    expect(canDecodeThumbnailFallback("a.png", 1024)).toBe(true);
  });

  // Mutation: case-sensitive extension check rejects uppercase a.PNG or fails at exact 20 MiB bound
  it("returns true for a.PNG 20 MiB", () => {
    expect(canDecodeThumbnailFallback("a.PNG", 20 * 1024 * 1024)).toBe(true);
  });

  // Mutation: size bound allows files larger than 20 MiB
  it("returns false for a.png 20 MiB + 1", () => {
    expect(canDecodeThumbnailFallback("a.png", 20 * 1024 * 1024 + 1)).toBe(false);
  });

  // Mutation: size bound allows 0-byte files
  it("returns false for a.png 0", () => {
    expect(canDecodeThumbnailFallback("a.png", 0)).toBe(false);
  });

  // Mutation: unsupported extensions (tiff, pdf, mp4) are mistakenly allowed
  it("returns false for a.tiff, a.pdf, a.mp4 1 KB", () => {
    expect(canDecodeThumbnailFallback("a.tiff", 1024)).toBe(false);
    expect(canDecodeThumbnailFallback("a.pdf", 1024)).toBe(false);
    expect(canDecodeThumbnailFallback("a.mp4", 1024)).toBe(false);
  });
});

describe("makeThumbnailPng", () => {
  it("never calls createFromPath when file size exceeds 20 MiB", async () => {
    // Catches mutation: bypassing fallback file size limit check (> 20 MiB)
    const createThumbnailFromPath = vi.fn().mockRejectedValue(new Error("no thumbnailer"));
    const createFromPath = vi.fn();
    const stat = vi.fn().mockResolvedValue({ size: 20 * 1024 * 1024 + 1 });
    const thumbnailPng = makeThumbnailPng({
      nativeImage: { createThumbnailFromPath, createFromPath },
      stat,
    });

    const res = await thumbnailPng("big.png", 128);
    expect(res).toBeNull();
    expect(createFromPath).not.toHaveBeenCalled();
  });

  it("never calls createFromPath for unsupported extension like tiff", async () => {
    // Catches mutation: allowing unsupported extension in fallback decoding
    const createThumbnailFromPath = vi.fn().mockRejectedValue(new Error("no thumbnailer"));
    const createFromPath = vi.fn();
    const stat = vi.fn().mockResolvedValue({ size: 1024 });
    const thumbnailPng = makeThumbnailPng({
      nativeImage: { createThumbnailFromPath, createFromPath },
      stat,
    });

    const res = await thumbnailPng("a.tiff", 128);
    expect(res).toBeNull();
    expect(createFromPath).not.toHaveBeenCalled();
  });

  it("never calls createFromPath when stat throws", async () => {
    // Catches mutation: attempting createFromPath when stat throws an error
    const createThumbnailFromPath = vi.fn().mockRejectedValue(new Error("no thumbnailer"));
    const createFromPath = vi.fn();
    const stat = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const thumbnailPng = makeThumbnailPng({
      nativeImage: { createThumbnailFromPath, createFromPath },
      stat,
    });

    const res = await thumbnailPng("a.png", 128);
    expect(res).toBeNull();
    expect(createFromPath).not.toHaveBeenCalled();
  });

  it("calls createFromPath and resizes to fit size for valid 1 KiB image when OS thumbnailer fails", async () => {
    // Catches mutation: failing to fallback-decode and resize supported image within size limit
    const createThumbnailFromPath = vi.fn().mockResolvedValue({
      isEmpty: () => true,
      toPNG: () => Buffer.from([]),
    });
    const fakeResized = {
      toPNG: () => Buffer.from([1, 2, 3, 4]),
    };
    const fakeImg = {
      isEmpty: () => false,
      getSize: () => ({ width: 400, height: 200 }),
      resize: vi.fn().mockReturnValue(fakeResized),
    };
    const createFromPath = vi.fn().mockReturnValue(fakeImg);
    const stat = vi.fn().mockResolvedValue({ size: 1024 });
    const thumbnailPng = makeThumbnailPng({
      nativeImage: { createThumbnailFromPath, createFromPath },
      stat,
    });

    const res = await thumbnailPng("a.png", 100);
    expect(createFromPath).toHaveBeenCalledWith("a.png");
    expect(fakeImg.resize).toHaveBeenCalledWith({ width: 100, height: 50, quality: "good" });
    expect(res).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("does not call stat or createFromPath when OS thumbnail succeeds", async () => {
    // Catches mutation: querying stat or createFromPath when OS thumbnailing succeeds
    const fakeOsImg = {
      isEmpty: () => false,
      toPNG: () => Buffer.from([9, 8, 7]),
    };
    const createThumbnailFromPath = vi.fn().mockResolvedValue(fakeOsImg);
    const createFromPath = vi.fn();
    const stat = vi.fn();
    const thumbnailPng = makeThumbnailPng({
      nativeImage: { createThumbnailFromPath, createFromPath },
      stat,
    });

    const res = await thumbnailPng("a.png", 128);
    expect(res).toEqual(new Uint8Array([9, 8, 7]));
    expect(stat).not.toHaveBeenCalled();
    expect(createFromPath).not.toHaveBeenCalled();
  });
});
