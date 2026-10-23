import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  validateReceipt,
  validateDecision,
  RECEIPT_LIMITS
} from "../../shared/receipt.mjs";

const fixturesRoot = existsSync(resolve(__dirname, "../../fixtures/receipt"))
  ? resolve(__dirname, "../../fixtures/receipt")
  : resolve(process.cwd(), "fixtures/receipt");

describe("receipt schema & fixtures", () => {
  it("passes all valid receipt fixtures", async () => {
    const validDir = join(fixturesRoot, "valid");
    const files = readdirSync(validDir).filter((f) => f.endsWith(".receipt.json"));
    expect(files.length).toBeGreaterThan(0);

    for (const filename of files) {
      const content = readFileSync(join(validDir, filename), "utf8");
      const result = await validateReceipt(content);
      expect(result.ok, `Expected ${filename} to be valid`).toBe(true);
      if (result.ok) {
        expect(result.receipt.uniview).toBe("receipt/1");
      }
    }
  });

  it("fails all invalid receipt fixtures with matching error code in filename", async () => {
    const invalidDir = join(fixturesRoot, "invalid");
    const files = readdirSync(invalidDir).filter((f) => f.endsWith(".receipt.json"));
    expect(files.length).toBeGreaterThan(0);

    for (const filename of files) {
      const parts = filename.split("--");
      const expectedCode = parts[0];
      const content = readFileSync(join(invalidDir, filename), "utf8");
      const result = await validateReceipt(content);
      expect(result.ok, `Expected ${filename} to fail`).toBe(false);
      if (!result.ok) {
        const codes = result.errors.map((e) => e.code);
        expect(codes, `Expected ${filename} to include code ${expectedCode}`).toContain(expectedCode);
      }
    }
  });

  it("validates decision fixtures correctly", async () => {
    const decisionDir = join(fixturesRoot, "decisions");
    const files = readdirSync(decisionDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    for (const filename of files) {
      const content = readFileSync(join(decisionDir, filename), "utf8");
      const result = await validateDecision(content);
      if (filename.startsWith("valid-")) {
        expect(result.ok, `Expected ${filename} to be valid`).toBe(true);
        if (result.ok) {
          expect(result.decision.uniview).toBe("decision/1");
        }
      } else if (filename.startsWith("invalid-")) {
        expect(result.ok, `Expected ${filename} to fail`).toBe(false);
        if (!result.ok) {
          expect(result.errors[0]?.code).toBe("schema");
        }
      }
    }
  });

  it("enforces files limit at 200 and 201", async () => {
    const base = {
      uniview: "receipt/1",
      createdAt: "2026-10-24T00:00:00Z",
      agent: { name: "test-agent" },
      task: "Testing file count limits",
      summary: "200 vs 201 boundary",
      files: [] as Array<{ path: string; sha256: string; role: "created" }>
    };

    const files200 = Array.from({ length: 200 }, (_, i) => ({
      path: `/workspace/file_${i}.txt`,
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      role: "created" as const
    }));

    const res200 = await validateReceipt({ ...base, files: files200 });
    expect(res200.ok).toBe(true);

    const files201 = Array.from({ length: 201 }, (_, i) => ({
      path: `/workspace/file_${i}.txt`,
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      role: "created" as const
    }));

    const res201 = await validateReceipt({ ...base, files: files201 });
    expect(res201.ok).toBe(false);
    if (!res201.ok) {
      expect(res201.errors.some((e) => e.code === "schema")).toBe(true);
    }
  });

  it("enforces summary UTF-8 byte boundary with multi-byte characters", async () => {
    const base = {
      uniview: "receipt/1",
      createdAt: "2026-10-24T00:00:00Z",
      agent: { name: "test-agent" },
      task: "Testing summary byte limits",
      summary: "",
      files: [
        {
          path: "/workspace/file.txt",
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          role: "created" as const
        }
      ]
    };

    // 'é' is 2 UTF-8 bytes. 131,072 * 2 = 262,144 bytes = 256 KiB exactly.
    const summaryAtLimit = "é".repeat(131072);
    const resAtLimit = await validateReceipt({ ...base, summary: summaryAtLimit });
    expect(resAtLimit.ok).toBe(true);

    // 262,143 ASCII 'a's + one 'é' (2 bytes) = 262,145 bytes, but 262,144 code points.
    // Passes code-point limit in schema, but exceeds UTF-8 byte limit in semantic validation.
    const summaryOverLimit = "a".repeat(262143) + "é";
    const resOverLimit = await validateReceipt({ ...base, summary: summaryOverLimit });
    expect(resOverLimit.ok).toBe(false);
    if (!resOverLimit.ok) {
      expect(resOverLimit.errors.some((e) => e.code === "schema" && e.path === "/summary")).toBe(true);
    }
  });

  it("enforces comment limit at 8 KiB and 8 KiB + 1 in decisions", async () => {
    const baseDecision = {
      uniview: "decision/1",
      reviewId: "0123456789abcdef0123456789abcdef",
      receiptDigest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      decision: "approved",
      comment: "",
      decidedAt: "2026-10-24T00:00:00Z",
      verifiedAt: "2026-10-24T00:00:00Z",
      persisted: true,
      files: [
        {
          path: "/workspace/file.txt",
          expectedSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          observedSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          state: "unchanged" as const
        }
      ]
    };

    const comment8KiB = "a".repeat(8192);
    const res8KiB = await validateDecision({ ...baseDecision, comment: comment8KiB });
    expect(res8KiB.ok).toBe(true);

    const comment8KiBPlus1 = "a".repeat(8193);
    const res8KiBPlus1 = await validateDecision({ ...baseDecision, comment: comment8KiBPlus1 });
    expect(res8KiBPlus1.ok).toBe(false);
    if (!res8KiBPlus1.ok) {
      expect(res8KiBPlus1.errors.some((e) => e.code === "schema" && e.path === "/comment")).toBe(true);
    }

    // Multi-byte boundary: 8191 'a's + one 'é' (2 bytes) = 8193 bytes, but 8192 characters.
    const commentMultiByteOver = "a".repeat(8191) + "é";
    const resMultiByteOver = await validateDecision({ ...baseDecision, comment: commentMultiByteOver });
    expect(resMultiByteOver.ok).toBe(false);
    if (!resMultiByteOver.ok) {
      expect(resMultiByteOver.errors.some((e) => e.code === "schema" && e.path === "/comment")).toBe(true);
    }
  });

  it("detects duplicate file paths across POSIX and Windows case insensitivity", async () => {
    const base = {
      uniview: "receipt/1",
      createdAt: "2026-10-24T00:00:00Z",
      agent: { name: "test-agent" },
      task: "Testing duplicate paths",
      summary: "Duplicate detection",
      files: [] as Array<{ path: string; sha256: string; role: "created" }>
    };

    const exactDup = await validateReceipt({
      ...base,
      files: [
        {
          path: "/workspace/src/index.ts",
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          role: "created"
        },
        {
          path: "/workspace/src/index.ts",
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          role: "created"
        }
      ]
    });
    expect(exactDup.ok).toBe(false);
    if (!exactDup.ok) {
      expect(exactDup.errors.some((e) => e.code === "schema" && e.message.includes("Duplicate"))).toBe(true);
    }

    const windowsCaseDup = await validateReceipt({
      ...base,
      files: [
        {
          path: "C:\\Workspace\\Src\\index.ts",
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          role: "created"
        },
        {
          path: "c:/workspace/src/INDEX.TS",
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          role: "created"
        }
      ]
    });
    expect(windowsCaseDup.ok).toBe(false);
    if (!windowsCaseDup.ok) {
      expect(windowsCaseDup.errors.some((e) => e.code === "schema" && e.message.includes("Duplicate"))).toBe(true);
    }
  });

  it("rejects unknown properties in receipts and decisions", async () => {
    const receiptWithUnknown = {
      uniview: "receipt/1",
      createdAt: "2026-10-24T00:00:00Z",
      agent: { name: "test-agent" },
      task: "Testing unknown properties",
      summary: "Disallowed additional properties",
      unknownKey: "value",
      files: [
        {
          path: "/workspace/file.txt",
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          role: "created" as const
        }
      ]
    };
    const resR = await validateReceipt(receiptWithUnknown);
    expect(resR.ok).toBe(false);
    if (!resR.ok) {
      expect(resR.errors.some((e) => e.code === "schema")).toBe(true);
    }

    const decisionWithUnknown = {
      uniview: "decision/1",
      reviewId: "0123456789abcdef0123456789abcdef",
      receiptDigest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      decision: "approved",
      comment: "Looks good",
      decidedAt: "2026-10-24T00:00:00Z",
      verifiedAt: "2026-10-24T00:00:00Z",
      persisted: true,
      unknownProp: 12345,
      files: [
        {
          path: "/workspace/file.txt",
          expectedSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          observedSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          state: "unchanged" as const
        }
      ]
    };
    const resD = await validateDecision(decisionWithUnknown);
    expect(resD.ok).toBe(false);
    if (!resD.ok) {
      expect(resD.errors.some((e) => e.code === "schema")).toBe(true);
    }
  });

  it("enforces file size check > 2 MiB with code too_large", async () => {
    const hugeInput = "a".repeat(RECEIPT_LIMITS.MAX_FILE_BYTES + 1);
    const res = await validateReceipt(hugeInput);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]?.code).toBe("too_large");
    }
  });
});
