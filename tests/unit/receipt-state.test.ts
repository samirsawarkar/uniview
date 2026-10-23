import { describe, it, expect } from "vitest";
import { fileState, canDecide } from "../../shared/receipt.mjs";
import type { FileState } from "../../shared/receipt.d.mts";

describe("fileState precedence table", () => {
  const exp = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const obs = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

  it("prioritizes missing over unreadable, tooLarge, replaced, and hash matches", () => {
    expect(fileState(exp, exp, { missing: true })).toBe("missing");
    expect(
      fileState(exp, exp, {
        missing: true,
        unreadable: true,
        tooLarge: true,
        replaced: true
      })
    ).toBe("missing");
  });

  it("prioritizes unreadable over tooLarge and replaced when not missing", () => {
    expect(fileState(exp, exp, { unreadable: true })).toBe("unreadable");
    expect(
      fileState(exp, exp, {
        unreadable: true,
        tooLarge: true,
        replaced: true
      })
    ).toBe("unreadable");
  });

  it("prioritizes too_large over replaced when not missing or unreadable", () => {
    expect(fileState(exp, exp, { tooLarge: true })).toBe("too_large");
    expect(
      fileState(exp, exp, {
        tooLarge: true,
        replaced: true
      })
    ).toBe("too_large");
  });

  it("prioritizes replaced over unchanged/changed when other flags are false", () => {
    expect(fileState(exp, exp, { replaced: true })).toBe("replaced");
    expect(fileState(exp, obs, { replaced: true })).toBe("replaced");
  });

  it("returns unchanged when observed equals expected and no flags are set", () => {
    expect(fileState(exp, exp)).toBe("unchanged");
    expect(fileState(exp, exp, {})).toBe("unchanged");
  });

  it("returns changed when observed differs from expected or is null", () => {
    expect(fileState(exp, obs)).toBe("changed");
    expect(fileState(exp, null)).toBe("changed");
  });
});

describe("canDecide verification rules", () => {
  const hashA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const hashB = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

  it("returns true for identical lists of states and observed hashes", () => {
    const shown: Array<{ state: FileState; observedSha256: string | null }> = [
      { state: "unchanged", observedSha256: hashA },
      { state: "changed", observedSha256: hashB },
      { state: "missing", observedSha256: null }
    ];
    const current: Array<{ state: FileState; observedSha256: string | null }> = [
      { state: "unchanged", observedSha256: hashA },
      { state: "changed", observedSha256: hashB },
      { state: "missing", observedSha256: null }
    ];
    expect(canDecide(shown, current)).toBe(true);
  });

  it("returns false for any state difference", () => {
    const shown: Array<{ state: FileState; observedSha256: string | null }> = [
      { state: "unchanged", observedSha256: hashA }
    ];
    const current: Array<{ state: FileState; observedSha256: string | null }> = [
      { state: "changed", observedSha256: hashA }
    ];
    expect(canDecide(shown, current)).toBe(false);
  });

  it("returns false for any observed hash difference", () => {
    const shown: Array<{ state: FileState; observedSha256: string | null }> = [
      { state: "changed", observedSha256: hashA }
    ];
    const current: Array<{ state: FileState; observedSha256: string | null }> = [
      { state: "changed", observedSha256: hashB }
    ];
    expect(canDecide(shown, current)).toBe(false);
  });

  it("returns false for difference in ordering", () => {
    const item1 = { state: "unchanged" as const, observedSha256: hashA };
    const item2 = { state: "changed" as const, observedSha256: hashB };

    expect(canDecide([item1, item2], [item2, item1])).toBe(false);
  });

  it("returns false for difference in list length", () => {
    const item1 = { state: "unchanged" as const, observedSha256: hashA };
    const item2 = { state: "changed" as const, observedSha256: hashB };

    expect(canDecide([item1], [item1, item2])).toBe(false);
    expect(canDecide([item1, item2], [item1])).toBe(false);
  });

  it("returns false if non-array arguments are provided", () => {
    expect(canDecide(null as unknown as [], [])).toBe(false);
    expect(canDecide([], undefined as unknown as [])).toBe(false);
  });
});
