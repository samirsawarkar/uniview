import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
// @ts-expect-error plain ESM module without types
import { parseRange, GrantStore, safeJoin, filesFromArgv, contentType, isAllowedUrl, checkReadArgs } from "../../electron/lib/core.mjs";

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
