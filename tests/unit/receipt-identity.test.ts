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
