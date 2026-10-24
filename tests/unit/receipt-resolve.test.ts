import { describe, it, expect } from "vitest";
import {
  resolveLanPath,
  matchCompanionFile,
  resolveReference,
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

describe("receipt-resolve references (images and fileRefs)", () => {
  it("marks unresolved image with placeholder 'image not available on this device'", () => {
    // Mutation: omitting placeholder text for unresolved images
    const resolved = resolveReference({
      kind: "image",
      path: "/desktop/only/pic.png",
      relPath: undefined,
    });
    expect(resolved.resolved).toBe(false);
    expect(resolved.placeholder).toBe("image not available on this device");
  });

  it("disables unresolved fileRefs", () => {
    // Mutation: leaving unresolved fileRef enabled
    const resolved = resolveReference({
      kind: "fileRef",
      path: "C:\\projects\\file.ts",
      relPath: undefined,
    });
    expect(resolved.resolved).toBe(false);
    expect(resolved.disabled).toBe(true);
  });

  it("enables resolved fileRefs when LAN path resolves", () => {
    // Mutation: disabling even resolved fileRefs
    const lanRoot: LanContext = {
      hostId: "host-1",
      rootId: "root-1",
      receiptPath: "dir/test.receipt.json",
    };
    const resolved = resolveReference(
      { kind: "fileRef", path: "C:\\projects\\file.ts", relPath: "file.ts" },
      lanRoot
    );
    expect(resolved.resolved).toBe(true);
    expect(resolved.disabled).toBe(false);
    expect(resolved.resolvedPath).toBe("dir/file.ts");
  });
});
