import { describe, it, expect } from "vitest";
import { receiptDigest, sha256Hex } from "../../shared/receipt.mjs";

describe("receiptDigest exact bytes guarantee", () => {
  it("produces equal digests for equal bytes", async () => {
    const raw = '{"uniview":"receipt/1","task":"same bytes"}';
    const b1 = new TextEncoder().encode(raw);
    const b2 = new TextEncoder().encode(raw);

    const d1 = await receiptDigest(b1);
    const d2 = await receiptDigest(b2);

    expect(d1).toBe(d2);
    expect(d1).toBe(await sha256Hex(b1));
  });

  it("produces different digests for different whitespace", async () => {
    const b1 = new TextEncoder().encode('{"uniview":"receipt/1","task":"build"}');
    const b2 = new TextEncoder().encode('{"uniview": "receipt/1", "task": "build"}');

    expect(await receiptDigest(b1)).not.toBe(await receiptDigest(b2));
  });

  it("produces different digests for different key order", async () => {
    const b1 = new TextEncoder().encode('{"a":1,"b":2}');
    const b2 = new TextEncoder().encode('{"b":2,"a":1}');

    expect(await receiptDigest(b1)).not.toBe(await receiptDigest(b2));
  });

  it("produces different digests for CRLF vs LF line endings", async () => {
    const bLF = new TextEncoder().encode('{"uniview":"receipt/1"}\n');
    const bCRLF = new TextEncoder().encode('{"uniview":"receipt/1"}\r\n');

    expect(await receiptDigest(bLF)).not.toBe(await receiptDigest(bCRLF));
  });

  it("produces different digests for unicode escapes vs literal non-ASCII characters", async () => {
    const bEscape = new TextEncoder().encode('{"summary":"caf\\u00e9"}');
    const bLiteral = new TextEncoder().encode('{"summary":"café"}');

    expect(await receiptDigest(bEscape)).not.toBe(await receiptDigest(bLiteral));
  });
});
