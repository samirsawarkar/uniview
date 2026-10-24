import { describe, it, expect, vi } from "vitest";
import {
  verifyReceiptWeb,
  WEB_HASH_LIMITS,
  type WebVerifyFile,
  type WebVerifySource,
} from "../../src/core/receipt-verify-web";
import { sha256Hex } from "../../shared/receipt.mjs";

describe("receipt-verify-web limits", () => {
  const dummyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // empty string hash

  it("accepts a file at exactly the 256 MiB per-file limit", async () => {
    // Mutation: off-by-one (< instead of <=) rejecting file at exactly 256 MiB limit
    const exactLimit = WEB_HASH_LIMITS.MAX_FILE_BYTES; // 256 * 1024 * 1024
    const file: WebVerifyFile = {
      path: "/repo/file.bin",
      expectedSha256: dummyHash,
      role: "modified",
    };
    const source: WebVerifySource = {
      size: exactLimit,
      readAll: async () => new Uint8Array(0).buffer,
      // Custom hasher hook for big simulated files to avoid 256MB memory allocation
      digestHex: async () => dummyHash,
    };

    const result = await verifyReceiptWeb([file], () => Promise.resolve(source));
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.state).toBe("unchanged");
  });

  it("rejects a file at 256 MiB + 1 byte as too_large", async () => {
    // Mutation: off-by-one (> instead of >=) allowing file of 256 MiB + 1 byte
    const overLimit = WEB_HASH_LIMITS.MAX_FILE_BYTES + 1; // 256 MiB + 1
    const file: WebVerifyFile = {
      path: "/repo/file.bin",
      expectedSha256: dummyHash,
      role: "modified",
    };
    const source: WebVerifySource = {
      size: overLimit,
      readAll: async () => new Uint8Array(0).buffer,
      digestHex: async () => dummyHash,
    };

    const result = await verifyReceiptWeb([file], () => Promise.resolve(source));
    expect(result.files.length).toBe(1);
    expect(result.files[0]!.state).toBe("too_large");
    expect(result.files[0]!.observedSha256).toBeNull();
  });

  it("accepts files whose cumulative size is exactly the 512 MiB per-receipt limit", async () => {
    // Mutation: off-by-one (< instead of <=) on per-receipt 512 MiB cumulative limit
    const halfLimit = WEB_HASH_LIMITS.MAX_RECEIPT_BYTES / 2; // 256 MiB each, sum = 512 MiB
    const files: WebVerifyFile[] = [
      { path: "/repo/file1.bin", expectedSha256: dummyHash, role: "created" },
      { path: "/repo/file2.bin", expectedSha256: dummyHash, role: "modified" },
    ];
    const source: WebVerifySource = {
      size: halfLimit,
      readAll: async () => new Uint8Array(0).buffer,
      digestHex: async () => dummyHash,
    };

    const result = await verifyReceiptWeb(files, () => Promise.resolve(source));
    expect(result.files.length).toBe(2);
    expect(result.files[0]!.state).toBe("unchanged");
    expect(result.files[1]!.state).toBe("unchanged");
  });

  it("marks a file that pushes the cumulative size over 512 MiB as too_large", async () => {
    // Mutation: failing to track cumulative bytes or allow 512 MiB + 1 byte total
    const halfLimit = WEB_HASH_LIMITS.MAX_RECEIPT_BYTES / 2; // 256 MiB
    const files: WebVerifyFile[] = [
      { path: "/repo/file1.bin", expectedSha256: dummyHash, role: "created" },
      { path: "/repo/file2.bin", expectedSha256: dummyHash, role: "modified" },
      { path: "/repo/file3.bin", expectedSha256: dummyHash, role: "modified" },
    ];
    // file1: 256 MiB, file2: 256 MiB (total 512 MiB), file3: 1 byte (total 512 MiB + 1)
    const resolver = async (f: WebVerifyFile): Promise<WebVerifySource> => {
      const size = f.path.endsWith("file3.bin") ? 1 : halfLimit;
      return {
        size,
        readAll: async () => new Uint8Array(0).buffer,
        digestHex: async () => dummyHash,
      };
    };

    const result = await verifyReceiptWeb(files, resolver);
    expect(result.files.length).toBe(3);
    expect(result.files[0]!.state).toBe("unchanged");
    expect(result.files[1]!.state).toBe("unchanged");
    expect(result.files[2]!.state).toBe("too_large");
  });

  it("hashes one file at a time sequentially (concurrency <= 1)", async () => {
    // Mutation: running file hashing concurrently with Promise.all
    let currentConcurrent = 0;
    let maxConcurrent = 0;

    const files: WebVerifyFile[] = [
      { path: "/repo/1.txt", expectedSha256: dummyHash, role: "input" },
      { path: "/repo/2.txt", expectedSha256: dummyHash, role: "input" },
      { path: "/repo/3.txt", expectedSha256: dummyHash, role: "input" },
    ];

    const resolver = async (): Promise<WebVerifySource> => ({
      size: 10,
      readAll: async () => {
        currentConcurrent++;
        if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
        await new Promise((r) => setTimeout(r, 10));
        currentConcurrent--;
        return new Uint8Array(10).buffer;
      },
    });

    await verifyReceiptWeb(files, resolver);
    expect(maxConcurrent).toBe(1);
  });

  it("hashes small files using real WebCrypto digest and identifies unchanged vs changed", async () => {
    // Mutation: returning hardcoded unchanged state or failing WebCrypto digest
    const sampleBytes = new TextEncoder().encode("Hello UniView Agent Receipt");
    const realHash = await sha256Hex(sampleBytes);
    const wrongHash = "0".repeat(64);

    const files: WebVerifyFile[] = [
      { path: "/repo/correct.txt", expectedSha256: realHash, role: "created" },
      { path: "/repo/tampered.txt", expectedSha256: wrongHash, role: "modified" },
    ];

    const resolver = async (f: WebVerifyFile): Promise<WebVerifySource> => ({
      size: sampleBytes.byteLength,
      readAll: async () => sampleBytes.buffer.slice(0),
    });

    const result = await verifyReceiptWeb(files, resolver);
    expect(result.files[0]!.state).toBe("unchanged");
    expect(result.files[0]!.observedSha256).toBe(realHash);

    expect(result.files[1]!.state).toBe("changed");
    expect(result.files[1]!.observedSha256).toBe(realHash);
  });

  it("marks file as missing when resolver returns null or undefined", async () => {
    // Mutation: throwing an exception or returning unreadable instead of missing
    const files: WebVerifyFile[] = [
      { path: "/repo/gone.txt", expectedSha256: dummyHash, role: "input" },
    ];
    const result = await verifyReceiptWeb(files, async () => null);
    expect(result.files[0]!.state).toBe("missing");
    expect(result.files[0]!.observedSha256).toBeNull();
  });

  it("marks file as unreadable when readAll throws an error", async () => {
    // Mutation: failing to catch read error and letting promise reject
    const files: WebVerifyFile[] = [
      { path: "/repo/locked.txt", expectedSha256: dummyHash, role: "input" },
    ];
    const source: WebVerifySource = {
      size: 100,
      readAll: async () => {
        throw new Error("Permission denied");
      },
    };
    const result = await verifyReceiptWeb(files, async () => source);
    expect(result.files[0]!.state).toBe("unreadable");
    expect(result.files[0]!.observedSha256).toBeNull();
  });

  it("stops before resolving the next file once the signal is aborted", async () => {
    // Mutation: ignoring opts.signal so a cancelled pass keeps reading files
    const ac = new AbortController();
    const files: WebVerifyFile[] = [
      { path: "/repo/1.txt", expectedSha256: dummyHash, role: "input" },
      { path: "/repo/2.txt", expectedSha256: dummyHash, role: "input" },
      { path: "/repo/3.txt", expectedSha256: dummyHash, role: "input" },
    ];
    const resolved: string[] = [];
    const result = await verifyReceiptWeb(
      files,
      async (f) => {
        resolved.push(f.path);
        if (f.path.endsWith("1.txt")) ac.abort();
        // digestHex: nothing is read, so only the loop's own check can stop the pass.
        return { size: 1, readAll: async () => new Uint8Array(1).buffer, digestHex: async () => dummyHash };
      },
      { signal: ac.signal }
    );
    expect(resolved).toEqual(["/repo/1.txt"]);
    expect(result.files.length).toBeLessThanOrEqual(1);
  });

  it("does not hash bytes that were read after the pass was aborted", async () => {
    // Mutation: hashing and reporting a file whose pass was cancelled while it was being read
    const ac = new AbortController();
    const seen: string[] = [];
    const result = await verifyReceiptWeb(
      [{ path: "/repo/1.txt", expectedSha256: dummyHash, role: "input" }],
      async () => ({
        size: 1,
        readAll: async () => {
          ac.abort();
          return new Uint8Array(1).buffer;
        },
      }),
      { signal: ac.signal, onFile: (f) => seen.push(f.path) }
    );
    expect(result.files).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("reports each file through onFile in receipt order with its index", async () => {
    // Mutation: dropping the progress callback so every file shows 'not checked' until the pass ends
    const files: WebVerifyFile[] = [
      { path: "/repo/a", expectedSha256: dummyHash, role: "input" },
      { path: "/repo/b", expectedSha256: dummyHash, role: "input" },
    ];
    const seen: Array<[string, number, string]> = [];
    await verifyReceiptWeb(files, async (f) => (f.path.endsWith("a") ? null : { size: 1, readAll: async () => { throw new Error("no"); } }), {
      onFile: (f, i) => seen.push([f.path, i, f.state]),
    });
    expect(seen).toEqual([
      ["/repo/a", 0, "missing"],
      ["/repo/b", 1, "unreadable"],
    ]);
  });

  it("counts prehashed bytes once: they are charged by the resolver, not again here", async () => {
    // Mutation: charging a prehashed file's bytes a second time (a 512 MiB receipt would fail spuriously)
    const half = WEB_HASH_LIMITS.MAX_RECEIPT_BYTES / 2;
    const budget = { used: half }; // the resolver already charged 256 MiB for this file
    const files: WebVerifyFile[] = [
      { path: "/repo/a", expectedSha256: dummyHash, role: "input" },
      { path: "/repo/b", expectedSha256: dummyHash, role: "input" },
    ];
    const result = await verifyReceiptWeb(
      files,
      async (f) =>
        f.path.endsWith("a")
          ? { size: half, readAll: async () => new ArrayBuffer(0), digestHex: async () => dummyHash, prehashed: true }
          : { size: half, readAll: async () => new ArrayBuffer(0), digestHex: async () => dummyHash },
      { budget }
    );
    expect(result.files.map((f) => f.state)).toEqual(["unchanged", "unchanged"]);
    expect(budget.used).toBe(WEB_HASH_LIMITS.MAX_RECEIPT_BYTES);
    expect(result.totalBytesHashed).toBe(WEB_HASH_LIMITS.MAX_RECEIPT_BYTES);
  });

  it("respects bytes already charged to a shared budget (limit and limit+1)", async () => {
    // Mutation: starting every pass from zero instead of the shared budget
    const files: WebVerifyFile[] = [{ path: "/repo/a", expectedSha256: dummyHash, role: "input" }];
    const mk = (): WebVerifySource => ({ size: 1, readAll: async () => new ArrayBuffer(0), digestHex: async () => dummyHash });
    const atLimit = await verifyReceiptWeb(files, async () => mk(), { budget: { used: WEB_HASH_LIMITS.MAX_RECEIPT_BYTES - 1 } });
    expect(atLimit.files[0]!.state).toBe("unchanged");
    const over = await verifyReceiptWeb(files, async () => mk(), { budget: { used: WEB_HASH_LIMITS.MAX_RECEIPT_BYTES } });
    expect(over.files[0]!.state).toBe("too_large");
  });
});
