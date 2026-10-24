import { describe, it, expect } from "vitest";
import {
  resolveLanPath,
  matchCompanionFile,
  type LanContext,
  type CompanionFile,
} from "../../src/core/receipt-resolve";

describe("receipt-resolve LAN paths", () => {
  const lanRoot: LanContext = {
    hostId: "host-alpha",
    rootId: "shared-root-1",
    receiptPath: "reviews/task-1/receipt.receipt.json",
  };

  it("resolves a relative relPath within the same folder on the same LAN root", () => {
    // Mutation: failing to prepend the receipt's folder when resolving LAN relPath
    const res = resolveLanPath("files/output.txt", lanRoot);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolvedPath).toBe("reviews/task-1/files/output.txt");
      expect(res.hostId).toBe("host-alpha");
      expect(res.rootId).toBe("shared-root-1");
    }
  });

  it("resolves relPath from a receipt at the root of the LAN share", () => {
    // Mutation: failing to handle receipts located at root directory of share
    const rootContext: LanContext = {
      hostId: "host-alpha",
      rootId: "shared-root-1",
      receiptPath: "receipt.receipt.json",
    };
    const res = resolveLanPath("summary.md", rootContext);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolvedPath).toBe("summary.md");
    }
  });

  it("resolves relPath with '..' segments that remain inside the LAN root", () => {
    // Mutation: rejecting all '..' segments instead of allowing ones contained in the root
    const res = resolveLanPath("../task-2/input.json", lanRoot);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolvedPath).toBe("reviews/task-2/input.json");
    }
  });

  it("rejects relPath with '..' that escapes the LAN root as missing", () => {
    // Mutation: allowing '..' path traversal to escape the LAN root
    const res = resolveLanPath("../../../outside.txt", lanRoot);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("missing");
    }
  });

  it("rejects '..' escape when receipt is at the root of the share", () => {
    // Mutation: allowing '..' traversal when starting at the root
    const rootContext: LanContext = {
      hostId: "host-alpha",
      rootId: "shared-root-1",
      receiptPath: "receipt.receipt.json",
    };
    const res = resolveLanPath("../secret.txt", rootContext);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("missing");
    }
  });

  it("rejects absolute relPath with leading slash as missing", () => {
    // Mutation: allowing absolute POSIX relPath on LAN share
    const res = resolveLanPath("/etc/passwd", lanRoot);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("missing");
    }
  });

  it("rejects absolute relPath with Windows drive letter as missing", () => {
    // Mutation: allowing Windows drive letter paths as relPath
    const res = resolveLanPath("C:\\secret.txt", lanRoot);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("missing");
    }
  });

  it("rejects absolute relPath with UNC prefix as missing", () => {
    // Mutation: allowing UNC network paths as relPath
    const res = resolveLanPath("\\\\server\\share\\file.txt", lanRoot);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("missing");
    }
  });

  it("rejects resolution when target host differs from receipt host", () => {
    // Mutation: ignoring host identity and allowing cross-host LAN resolution
    const res = resolveLanPath("files/output.txt", lanRoot, { targetHostId: "host-beta" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("missing");
    }
  });

  it("rejects resolution when target root differs from receipt root", () => {
    // Mutation: ignoring root identity and allowing cross-root LAN resolution
    const res = resolveLanPath("files/output.txt", lanRoot, { targetRootId: "other-root" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("missing");
    }
  });

  it("rejects undefined or empty relPath as missing", () => {
    // Mutation: treating undefined or empty relPath as success
    const res1 = resolveLanPath(undefined, lanRoot);
    expect(res1.ok).toBe(false);
    const res2 = resolveLanPath("", lanRoot);
    expect(res2.ok).toBe(false);
  });
});

describe("receipt-resolve LAN path hardening", () => {
  const lanRoot: LanContext = {
    hostId: "host-alpha",
    rootId: "shared-root-1",
    receiptPath: "reviews/task-1/receipt.receipt.json",
  };
  const rootCtx: LanContext = { hostId: "h", rootId: "r", receiptPath: "receipt.receipt.json" };

  function missing(rel: string, ctx: LanContext = lanRoot) {
    const res = resolveLanPath(rel, ctx);
    expect(res.ok, `expected missing for ${JSON.stringify(rel)}`).toBe(false);
  }

  it("treats segments that are '..' after trimming trailing dots and spaces as escapes", () => {
    // Mutation: comparing the raw segment to '..' only (Windows hosts strip trailing dots and spaces)
    missing("../../../outside.txt");
    missing(".. /x.txt", rootCtx);
    missing("... /x.txt", rootCtx);
    missing(".. ../x.txt", rootCtx);
    missing("a/.. /../../x.txt");
    missing("..\\x.txt", rootCtx);
    missing("sub/... /x.txt", rootCtx);
  });

  it("rejects segments with NUL or other control characters", () => {
    // Mutation: letting a NUL or control character reach the host path
    missing("a\u0000b.txt");
    missing("dir/file.txt\u0000.png");
    missing("a\u001fb.txt");
    missing("a\u007fb.txt");
    missing("a\nb.txt");
    missing("a\tb.txt");
  });

  it("rejects a receipt path whose own folder escapes the root", () => {
    // Mutation: trusting the receipt's own path and letting '..' in it leave the root
    missing("x.txt", { ...lanRoot, receiptPath: "../receipt.receipt.json" });
    missing("x.txt", { ...lanRoot, receiptPath: "a/../../receipt.receipt.json" });
    missing("x.txt", { ...lanRoot, receiptPath: "..\\..\\receipt.receipt.json" });
    const ok = resolveLanPath("x.txt", { ...lanRoot, receiptPath: "a/../receipt.receipt.json" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.resolvedPath).toBe("x.txt");
  });

  it("rejects a relPath that resolves to the folder itself", () => {
    // Mutation: returning ok with an empty resolvedPath for '.' or 'a/..'
    missing(".", rootCtx);
    missing("a/..", rootCtx);
    missing("./", rootCtx);
  });

  it("keeps percent-encoded dots literal (no decoding)", () => {
    // Mutation: decoding %2e%2e so an encoded traversal becomes '..'
    const res = resolveLanPath("%2e%2e/x.txt", rootCtx);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolvedPath).toBe("%2e%2e/x.txt");
    const res2 = resolveLanPath("%2E%2E%2Fx.txt", rootCtx);
    expect(res2.ok).toBe(true);
    if (res2.ok) expect(res2.resolvedPath).toBe("%2E%2E%2Fx.txt");
  });

  it("treats backslashes and mixed separators as separators", () => {
    // Mutation: splitting on '/' only so a backslash '..' goes unnoticed
    const res = resolveLanPath("a\\b/c\\d.txt", rootCtx);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolvedPath).toBe("a/b/c/d.txt");
    missing("a\\..\\..\\x.txt", rootCtx);
    missing("a/..\\../x.txt", rootCtx);
    const inside = resolveLanPath("a/..\\b.txt", rootCtx);
    expect(inside.ok).toBe(true);
    if (inside.ok) expect(inside.resolvedPath).toBe("b.txt");
  });

  it("rejects drive-letter, drive-relative and UNC forms in every spelling", () => {
    // Mutation: only checking 'C:\\' and not 'C:' or '//server' spellings
    missing("C:\\x.txt");
    missing("c:/x.txt");
    missing("C:x.txt");
    missing("\\\\server\\share\\x.txt");
    missing("//server/share/x.txt");
    missing("\\\\?\\C:\\x.txt");
    missing("/x.txt");
    missing("\\x.txt");
  });

  it("keeps unicode names literal and does not treat fullwidth dots as '..'", () => {
    // Mutation: Unicode normalisation turning fullwidth dots into '..'
    const name = "\u2025/\uff0e\uff0e/\u00e9t\u00e9/\u6587\u4ef6.txt";
    const res = resolveLanPath(name, rootCtx);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolvedPath).toBe(name);
  });

  it("does not trim ordinary names with inner dots or spaces", () => {
    // Mutation: over-eager trimming that rejects 'a b.txt' or 'v1.2.txt'
    const res = resolveLanPath("my notes v1.2.txt", rootCtx);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolvedPath).toBe("my notes v1.2.txt");
  });
});

describe("receipt-resolve companion files", () => {
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  const hashC = "c".repeat(64);

  it("matches a single companion file by filename", () => {
    // Mutation: failing to match companion file by file name
    const companions: CompanionFile[] = [
      { id: "c1", name: "output.txt", size: 100, sha256: hashA },
    ];
    const res = matchCompanionFile("C:\\work\\output.txt", hashA, companions);
    expect(res.status).toBe("matched");
    if (res.status === "matched") {
      expect(res.file.id).toBe("c1");
    }
  });

  it("matches companion file case-insensitively by filename", () => {
    // Mutation: case-sensitive name check failing on Windows/cross-platform companion names
    const companions: CompanionFile[] = [
      { id: "c1", name: "OUTPUT.TXT", size: 100, sha256: hashA },
    ];
    const res = matchCompanionFile("C:\\work\\output.txt", hashA, companions);
    expect(res.status).toBe("matched");
    if (res.status === "matched") {
      expect(res.file.id).toBe("c1");
    }
  });

  it("returns missing when no companion file matches by name", () => {
    // Mutation: matching arbitrary companion file when name does not match
    const companions: CompanionFile[] = [
      { id: "c1", name: "other.txt", size: 100, sha256: hashA },
    ];
    const res = matchCompanionFile("C:\\work\\output.txt", hashA, companions);
    expect(res.status).toBe("missing");
  });

  it("disambiguates duplicates with matching file names by hash", () => {
    // Mutation: returning first duplicate or ambiguous instead of checking expected hash
    const companions: CompanionFile[] = [
      { id: "c1", name: "output.txt", size: 100, sha256: hashB },
      { id: "c2", name: "output.txt", size: 100, sha256: hashA },
    ];
    const res = matchCompanionFile("output.txt", hashA, companions);
    expect(res.status).toBe("matched");
    if (res.status === "matched") {
      expect(res.file.id).toBe("c2");
    }
  });

  it("returns ambiguous when duplicates have different hashes and none match expected hash", () => {
    // Mutation: arbitrarily picking a duplicate when hash does not match
    const companions: CompanionFile[] = [
      { id: "c1", name: "output.txt", size: 100, sha256: hashB },
      { id: "c2", name: "output.txt", size: 100, sha256: hashC },
    ];
    const res = matchCompanionFile("output.txt", hashA, companions);
    expect(res.status).toBe("ambiguous");
    if (res.status === "ambiguous") {
      expect(res.candidates.length).toBe(2);
    }
  });

  it("returns ambiguous when multiple duplicates have the same expected hash", () => {
    // Mutation: failing to report ambiguous when multiple duplicate files both match hash
    const companions: CompanionFile[] = [
      { id: "c1", name: "output.txt", size: 100, sha256: hashA },
      { id: "c2", name: "output.txt", size: 100, sha256: hashA },
    ];
    const res = matchCompanionFile("output.txt", hashA, companions);
    expect(res.status).toBe("ambiguous");
    if (res.status === "ambiguous") {
      expect(res.candidates.length).toBe(2);
    }
  });
});
