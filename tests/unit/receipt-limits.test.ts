import { describe, it, expect } from "vitest";
import {
  validateReceipt,
  validateDecision,
  RECEIPT_LIMITS
} from "../../shared/receipt.mjs";

function makeBaseReceipt(): Record<string, any> {
  return {
    uniview: "receipt/1",
    createdAt: "2026-03-30T10:00:00Z",
    agent: {
      name: "valid-agent"
    },
    task: "Initial task description",
    summary: "Task summary",
    files: [
      {
        path: "/w/a.txt",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        role: "created"
      }
    ]
  };
}

function makeBaseDecision() {
  return {
    uniview: "decision/1",
    reviewId: "0123456789abcdef0123456789abcdef",
    receiptDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    decision: "approved",
    comment: "LGTM",
    decidedAt: "2026-03-30T10:00:00Z",
    verifiedAt: "2026-03-30T10:00:01Z",
    persisted: true,
    files: [
      {
        path: "/w/a.txt",
        expectedSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        observedSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        state: "unchanged"
      }
    ]
  };
}

describe("Fix 1: Character limits vs byte limits", () => {
  // Catches mutation: agent.name byte check wrongly rejects multi-byte CJK within 80 code points
  it("accepts 80 CJK characters in agent.name and rejects 81 characters", async () => {
    const validReceipt = makeBaseReceipt();
    validReceipt.agent.name = "漢".repeat(80);
    const validRes = await validateReceipt(validReceipt);
    expect(validRes.ok).toBe(true);

    const invalidReceipt = makeBaseReceipt();
    invalidReceipt.agent.name = "漢".repeat(81);
    const invalidRes = await validateReceipt(invalidReceipt);
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/agent/name"
        })
      ])
    );
  });

  it("accepts 4096-character absolute path and rejects 4097-character path", async () => {
    // Catches mutation: files[].path byte check wrongly rejects path > 4096 bytes but <= 4096 characters
    const validReceipt = makeBaseReceipt();
    validReceipt.files[0] = {
      path: "/" + "é".repeat(4095),
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      role: "created"
    };
    const validRes = await validateReceipt(validReceipt);
    expect(validRes.ok).toBe(true);

    const invalidReceipt = makeBaseReceipt();
    invalidReceipt.files[0] = {
      path: "/" + "é".repeat(4096),
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      role: "created"
    };
    const invalidRes = await validateReceipt(invalidReceipt);
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/files/0/path"
        })
      ])
    );
  });
});

describe("Fix 2: Lexical normal form for duplicate path comparison", () => {
  // Catches mutation: Failure to collapse '.' segments in duplicate detection
  it("detects duplicates between /w/a.txt and /w/./a.txt", async () => {
    const receipt = makeBaseReceipt();
    receipt.files = [
      {
        path: "/w/a.txt",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        role: "created"
      },
      {
        path: "/w/./a.txt",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        role: "modified"
      }
    ];
    const res = await validateReceipt(receipt);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/files/1/path",
          message: "duplicate of /files/0/path"
        })
      ])
    );
  });

  // Catches mutation: Failure to resolve '..' segments against previous segment
  it("detects duplicates between /w/a.txt and /w/b/../a.txt", async () => {
    const receipt = makeBaseReceipt();
    receipt.files = [
      {
        path: "/w/a.txt",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        role: "created"
      },
      {
        path: "/w/b/../a.txt",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        role: "modified"
      }
    ];
    const res = await validateReceipt(receipt);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/files/1/path",
          message: "duplicate of /files/0/path"
        })
      ])
    );
  });

  // Catches mutation: Failure to collapse repeated separators '//'
  it("detects duplicates between /w/a.txt and /w//a.txt", async () => {
    const receipt = makeBaseReceipt();
    receipt.files = [
      {
        path: "/w/a.txt",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        role: "created"
      },
      {
        path: "/w//a.txt",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        role: "modified"
      }
    ];
    const res = await validateReceipt(receipt);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/files/1/path",
          message: "duplicate of /files/0/path"
        })
      ])
    );
  });

  // Catches mutation: Failure to case-fold Windows drive paths and normalize backslashes
  it("detects duplicates between C:\\W\\A.txt and c:/w/a.txt", async () => {
    const receipt = makeBaseReceipt();
    receipt.files = [
      {
        path: "C:\\W\\A.txt",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        role: "created"
      },
      {
        path: "c:/w/a.txt",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        role: "modified"
      }
    ];
    const res = await validateReceipt(receipt);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/files/1/path",
          message: "duplicate of /files/0/path"
        })
      ])
    );
  });

  // Catches mutation: POSIX paths wrongly case-folded in duplicate comparison
  it("does not treat /w/A.txt and /w/a.txt as duplicates (POSIX case sensitivity)", async () => {
    const receipt = makeBaseReceipt();
    receipt.files = [
      {
        path: "/w/A.txt",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        role: "created"
      },
      {
        path: "/w/a.txt",
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        role: "modified"
      }
    ];
    const res = await validateReceipt(receipt);
    expect(res.ok).toBe(true);
  });
});

describe("Fix 3: Calendar-valid timestamps", () => {
  // Catches mutation: Missing calendar validation allows month/day/time 99
  it("rejects 2026-99-99T99:99:99Z in createdAt", async () => {
    const receipt = makeBaseReceipt();
    receipt.createdAt = "2026-99-99T99:99:99Z";
    const res = await validateReceipt(receipt);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/createdAt",
          message: "not a valid date-time"
        })
      ])
    );
  });

  // Catches mutation: Non-leap year February 29 erroneously accepted
  it("rejects 2026-02-29T00:00:00Z in createdAt", async () => {
    const receipt = makeBaseReceipt();
    receipt.createdAt = "2026-02-29T00:00:00Z";
    const res = await validateReceipt(receipt);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/createdAt",
          message: "not a valid date-time"
        })
      ])
    );
  });

  // Catches mutation: Leap year Feb 29 and leap second 60 erroneously rejected
  it("accepts leap day and leap second in 2024-02-29T23:59:60+05:30", async () => {
    const receipt = makeBaseReceipt();
    receipt.createdAt = "2024-02-29T23:59:60+05:30";
    const res = await validateReceipt(receipt);
    expect(res.ok).toBe(true);
  });

  // Catches mutation: Day 31 in 30-day month (April) erroneously accepted
  it("rejects 2026-04-31T00:00:00Z in createdAt", async () => {
    const receipt = makeBaseReceipt();
    receipt.createdAt = "2026-04-31T00:00:00Z";
    const res = await validateReceipt(receipt);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/createdAt",
          message: "not a valid date-time"
        })
      ])
    );
  });

  // Catches mutation: Fractional seconds in calendar-valid date-time erroneously rejected
  it("accepts valid fractional timestamp 2026-12-31T23:59:59.123Z", async () => {
    const receipt = makeBaseReceipt();
    receipt.createdAt = "2026-12-31T23:59:59.123Z";
    const res = await validateReceipt(receipt);
    expect(res.ok).toBe(true);
  });

  // Catches mutation: Offset hour >= 24 erroneously accepted
  it("rejects offset +24:00 in createdAt", async () => {
    const receipt = makeBaseReceipt();
    receipt.createdAt = "2026-01-01T00:00:00+24:00";
    const res = await validateReceipt(receipt);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/createdAt",
          message: "not a valid date-time"
        })
      ])
    );
  });

  // Catches mutation: Calendar check not applied to decision decidedAt and verifiedAt
  it("enforces calendar validation on decision decidedAt and verifiedAt", async () => {
    const decisionBadDecided = makeBaseDecision();
    decisionBadDecided.decidedAt = "2026-99-99T99:99:99Z";
    const res1 = await validateDecision(decisionBadDecided);
    expect(res1.ok).toBe(false);
    expect(res1.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/decidedAt",
          message: "not a valid date-time"
        })
      ])
    );

    const decisionBadVerified = makeBaseDecision();
    decisionBadVerified.verifiedAt = "2026-02-29T00:00:00Z";
    const res2 = await validateDecision(decisionBadVerified);
    expect(res2.ok).toBe(false);
    expect(res2.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/verifiedAt",
          message: "not a valid date-time"
        })
      ])
    );

    const decisionValid = makeBaseDecision();
    decisionValid.decidedAt = "2024-02-29T23:59:60+05:30";
    decisionValid.verifiedAt = "2026-12-31T23:59:59.123Z";
    const res3 = await validateDecision(decisionValid);
    expect(res3.ok).toBe(true);
  });
});

describe("Fix 4: Boundary tests using multi-byte characters and item limits", () => {
  // Catches mutation: task limit checks code points rather than UTF-8 byte length
  it("checks task limit at 2048 bytes (pass) and 2049 bytes (fail) using multi-byte characters", async () => {
    // 'é' is 2 bytes; 1024 * 2 = 2048 bytes (1024 characters <= 2048)
    const validReceipt = makeBaseReceipt();
    validReceipt.task = "é".repeat(1024);
    const validRes = await validateReceipt(validReceipt);
    expect(validRes.ok).toBe(true);

    // 1024 * 2 + 1 = 2049 bytes (1025 characters <= 2048, so code-point check would pass)
    const invalidReceipt = makeBaseReceipt();
    invalidReceipt.task = "é".repeat(1024) + "a";
    const invalidRes = await validateReceipt(invalidReceipt);
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/task"
        })
      ])
    );
  });

  // Catches mutation: checks[].evidence checks code points rather than UTF-8 byte length
  it("checks checks[].evidence limit at 16384 bytes (pass) and 16385 bytes (fail)", async () => {
    // 8192 * 2 = 16384 bytes
    const validReceipt = makeBaseReceipt();
    validReceipt.checks = [
      {
        name: "test-check",
        status: "pass",
        evidence: "é".repeat(8192)
      }
    ];
    const validRes = await validateReceipt(validReceipt);
    expect(validRes.ok).toBe(true);

    // 8192 * 2 + 1 = 16385 bytes (8193 characters <= 16384)
    const invalidReceipt = makeBaseReceipt();
    invalidReceipt.checks = [
      {
        name: "test-check",
        status: "pass",
        evidence: "é".repeat(8192) + "a"
      }
    ];
    const invalidRes = await validateReceipt(invalidReceipt);
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/checks/0/evidence"
        })
      ])
    );
  });

  // Catches mutation: sources[].ref checks code points rather than UTF-8 byte length
  it("checks sources[].ref limit at 2048 bytes (pass) and 2049 bytes (fail)", async () => {
    // 1024 * 2 = 2048 bytes
    const validReceipt = makeBaseReceipt();
    validReceipt.sources = [
      {
        title: "source-title",
        ref: "é".repeat(1024)
      }
    ];
    const validRes = await validateReceipt(validReceipt);
    expect(validRes.ok).toBe(true);

    // 1024 * 2 + 1 = 2049 bytes (1025 characters <= 2048)
    const invalidReceipt = makeBaseReceipt();
    invalidReceipt.sources = [
      {
        title: "source-title",
        ref: "é".repeat(1024) + "a"
      }
    ];
    const invalidRes = await validateReceipt(invalidReceipt);
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/sources/0/ref"
        })
      ])
    );
  });

  // Catches mutation: checks array allows more than 200 items
  it("checks checks items boundary at 200 items (pass) and 201 items (fail)", async () => {
    const validReceipt = makeBaseReceipt();
    validReceipt.checks = Array.from({ length: 200 }, (_, i) => ({
      name: `check-${i}`,
      status: "pass" as const
    }));
    const validRes = await validateReceipt(validReceipt);
    expect(validRes.ok).toBe(true);

    const invalidReceipt = makeBaseReceipt();
    invalidReceipt.checks = Array.from({ length: 201 }, (_, i) => ({
      name: `check-${i}`,
      status: "pass" as const
    }));
    const invalidRes = await validateReceipt(invalidReceipt);
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/checks"
        })
      ])
    );
  });

  // Catches mutation: sources array allows more than 200 items
  it("checks sources items boundary at 200 items (pass) and 201 items (fail)", async () => {
    const validReceipt = makeBaseReceipt();
    validReceipt.sources = Array.from({ length: 200 }, (_, i) => ({
      title: `source-${i}`,
      ref: "https://example.com"
    }));
    const validRes = await validateReceipt(validReceipt);
    expect(validRes.ok).toBe(true);

    const invalidReceipt = makeBaseReceipt();
    invalidReceipt.sources = Array.from({ length: 201 }, (_, i) => ({
      title: `source-${i}`,
      ref: "https://example.com"
    }));
    const invalidRes = await validateReceipt(invalidReceipt);
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          path: "/sources"
        })
      ])
    );
  });

  // Catches mutation: viewRelPath accepts traversal segments or absolute paths without returning bad_path
  it("validates viewRelPath: views/a.uview.json valid and ../a, /a, C:/a, a/../b invalid with bad_path", async () => {
    const validReceipt = makeBaseReceipt();
    validReceipt.viewRelPath = "views/a.uview.json";
    const validRes = await validateReceipt(validReceipt);
    expect(validRes.ok).toBe(true);

    const invalidPaths = ["../a", "/a", "C:/a", "a/../b"];
    for (const invalidPath of invalidPaths) {
      const receipt = makeBaseReceipt();
      receipt.viewRelPath = invalidPath;
      const res = await validateReceipt(receipt);
      expect(res.ok).toBe(false);
      expect(res.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "bad_path",
            path: "/viewRelPath"
          })
        ])
      );
    }
  });
});
