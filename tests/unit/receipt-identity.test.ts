import { describe, it, expect } from "vitest";
import { canDecide } from "../../shared/receipt.mjs";

type Item = {
  state: "unchanged" | "changed" | "replaced";
  observedSha256: string | null;
  path?: string;
  identity?: { dev: string; ino: string } | null;
};

const hashA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("canDecide file identity (P14b-1b finding 1)", () => {
  const base = (identity: Item["identity"]): Item => ({ state: "replaced", observedSha256: hashA, path: "C:/a.txt", identity });

  // Mutation caught: canDecide comparing only state/hash/path, so a second replacement with identical bytes passes.
  it("returns false when the dev/ino identity differs although state and hash match", () => {
    expect(canDecide([base({ dev: "1", ino: "2" })], [base({ dev: "1", ino: "3" })])).toBe(false);
    expect(canDecide([base({ dev: "1", ino: "2" })], [base({ dev: "9", ino: "2" })])).toBe(false);
  });

  // Mutation caught: treating a missing identity on one side as "no information, allow".
  it("returns false when only one side has an identity", () => {
    expect(canDecide([base({ dev: "1", ino: "2" })], [base(null)])).toBe(false);
    expect(canDecide([base(null)], [base({ dev: "1", ino: "2" })])).toBe(false);
  });

  // Mutation caught: over-rejecting (e.g. comparing identity objects by reference).
  it("returns true for equal identities (distinct objects) and for two absent identities", () => {
    expect(canDecide([base({ dev: "1", ino: "2" })], [base({ dev: "1", ino: "2" })])).toBe(true);
    expect(canDecide([base(null)], [base(undefined)])).toBe(true);
  });
});

describe("canDecide identity quality (P14b-1d finding 2)", () => {
  type Q = "inode" | "fingerprint" | "none";
  const fp = (mtimeMs = "1000", birthtimeMs: string | null = "500", size = "10") => ({ size, mtimeMs, birthtimeMs });
  const item = (quality: Q | null, over: Record<string, unknown> = {}) => ({
    state: "unchanged" as const,
    observedSha256: hashA,
    path: "C:/a.txt",
    identity: { dev: "1", ino: "0" },
    identityQuality: quality,
    fingerprint: fp(),
    ...over,
  });

  // Mutation caught: a file with no comparable identity being approvable.
  it("never allows a file whose identity quality is none", () => {
    expect(canDecide([item("none")], [item("none")])).toBe(false);
    expect(canDecide([item("inode")], [item("none")])).toBe(false);
  });

  // Mutation caught: comparing an inode-quality file against a fingerprint-quality one (the ino became unusable).
  it("requires both sides to have the same quality", () => {
    // identical identity and metadata: only the quality differs
    const id = { identity: { dev: "1", ino: "5" } };
    expect(canDecide([item("inode", id)], [item("inode", id)])).toBe(true);
    expect(canDecide([item("inode", id)], [item("fingerprint", id)])).toBe(false);
    expect(canDecide([item("fingerprint", id)], [item("inode", id)])).toBe(false);
  });

  // Mutation caught: fingerprint ignored for volumes without usable inode numbers (same ino 0 on every file).
  it("fingerprint quality compares size, mtime and birth time", () => {
    expect(canDecide([item("fingerprint")], [item("fingerprint")])).toBe(true);
    expect(canDecide([item("fingerprint")], [item("fingerprint", { fingerprint: fp("2000") })])).toBe(false);
    expect(canDecide([item("fingerprint")], [item("fingerprint", { fingerprint: fp("1000", "900") })])).toBe(false);
    expect(canDecide([item("fingerprint")], [item("fingerprint", { fingerprint: fp("1000", "500", "11") })])).toBe(false);
    expect(canDecide([item("fingerprint")], [item("fingerprint", { fingerprint: null })])).toBe(false);
    expect(canDecide([item("fingerprint", { fingerprint: null })], [item("fingerprint", { fingerprint: null })])).toBe(false);
  });

  // Mutation caught: inode quality ignoring a changed creation time (inode reuse) when metadata is available.
  it("inode quality also compares the metadata when both sides have it", () => {
    const a = item("inode", { identity: { dev: "1", ino: "5" } });
    expect(canDecide([a], [item("inode", { identity: { dev: "1", ino: "5" } })])).toBe(true);
    expect(canDecide([a], [item("inode", { identity: { dev: "1", ino: "5" }, fingerprint: fp("1000", "900") })])).toBe(false);
    expect(canDecide([a], [item("inode", { identity: { dev: "1", ino: "5" }, fingerprint: null })])).toBe(true);
  });
});
