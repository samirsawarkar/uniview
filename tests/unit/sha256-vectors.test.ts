import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { sha256Hex } from "../../shared/receipt.mjs";

describe("sha256Hex vectors & node:crypto parity", () => {
  it("hashes empty input matching NIST vector", async () => {
    const input = new Uint8Array(0);
    const hex = await sha256Hex(input);
    const expected = createHash("sha256").update(input).digest("hex");
    expect(hex).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex).toBe(expected);
  });

  it("hashes 'abc' matching NIST vector", async () => {
    const input = new TextEncoder().encode("abc");
    const hex = await sha256Hex(input);
    const expected = createHash("sha256").update(input).digest("hex");
    expect(hex).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hex).toBe(expected);
  });

  it("hashes 56-byte NIST vector", async () => {
    const input = new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq");
    expect(input.byteLength).toBe(56);
    const hex = await sha256Hex(input);
    const expected = createHash("sha256").update(input).digest("hex");
    expect(hex).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(hex).toBe(expected);
  });

  it("hashes 112-byte NIST vector", async () => {
    // FIPS 180-2 / NIST "two-block" 112-byte message.
    const input = new TextEncoder().encode(
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
    );
    expect(input.byteLength).toBe(112);
    const hex = await sha256Hex(input);
    const expected = createHash("sha256").update(input).digest("hex");
    expect(hex).toBe("cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
    expect(hex).toBe(expected);
  });

  it("matches node:crypto for generated inputs of 1, 63, 64, 65, 1 MiB and 1 MiB + 1 bytes", async () => {
    const sizes = [1, 63, 64, 65, 1024 * 1024, 1024 * 1024 + 1];

    for (const size of sizes) {
      const arr = new Uint8Array(size);
      arr.fill((size * 17) & 0xff);
      const hex = await sha256Hex(arr);
      const expected = createHash("sha256").update(arr).digest("hex");
      expect(hex).toBe(expected);
    }
  });
});
