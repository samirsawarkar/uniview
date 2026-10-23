// Adversarial archives from the Codex re-review (aes run aes-d9f453e8d014, finding 1).
import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { assertZipWithinBudget, listZip, readZipEntries, ZipPackage } from "../../src/core/zip";
import { CorruptFileError } from "../../src/core/errors";

/** Rewrite the declared uncompressed size of every central-directory entry named `name`. */
function forgeDeclaredSize(zip: Uint8Array, name: string, size: number): Uint8Array {
  const b = zip.slice();
  const v = new DataView(b.buffer);
  const n = strToU8(name);
  for (let i = 0; i + 46 < b.length; i++) {
    if (v.getUint32(i, true) !== 0x02014b50) continue;
    const len = v.getUint16(i + 28, true);
    const got = b.subarray(i + 46, i + 46 + len);
    if (len === n.length && got.every((c, k) => c === n[k])) v.setUint32(i + 24, size, true);
  }
  return b;
}

/** Concatenate two archives' entries so the same name appears twice (central directory of the first + second). */
function duplicateNames(): Uint8Array {
  const a = zipSync({ "x.bin": new Uint8Array(400_000) }, { level: 9 });
  // Build an archive with two entries, then rename the second to collide with the first.
  const two = zipSync({ "x.bin": new Uint8Array(400_000), "y.bin": new Uint8Array(400_000) }, { level: 9 });
  const b = two.slice();
  for (let i = 0; i + 5 < b.length; i++) if (b[i] === 0x79 && b[i + 1] === 0x2e && b[i + 2] === 0x62 && b[i + 3] === 0x69 && b[i + 4] === 0x6e) b[i] = 0x78; // y.bin -> x.bin
  void a;
  return b;
}

describe("bounded ZIP extraction", () => {
  it("lists a duplicated name once and inflates it once", () => {
    const zip = duplicateNames();
    expect(listZip(zip).map((e) => e.name)).toEqual(["x.bin"]);
    expect(() => readZipEntries(zip, () => true, 500_000)).not.toThrow();
    expect([...readZipEntries(zip, () => true, 500_000).values()][0]!.length).toBe(400_000);
  });

  it("refuses a stored entry larger than it declares", () => {
    const zip = forgeDeclaredSize(zipSync({ "s.bin": [new Uint8Array(100_000), { level: 0 }] }), "s.bin", 1);
    expect(() => new ZipPackage(zip, 10).bytesOf("s.bin")).toThrow(CorruptFileError);
    expect(() => new ZipPackage(zip).bytesOf("s.bin")).toThrow(/larger than this archive says/);
  });

  it("stops inflating a deflated entry that lies about its size, before finishing", () => {
    const zip = forgeDeclaredSize(zipSync({ "d.bin": new Uint8Array(5_000_000) }, { level: 9 }), "d.bin", 10);
    expect(() => new ZipPackage(zip).bytesOf("d.bin")).toThrow(/larger than this archive says/);
  });

  it("enforces the package budget on real output, not declarations", () => {
    const big = new Uint8Array(600_000);
    const zip = forgeDeclaredSize(forgeDeclaredSize(zipSync({ "a.bin": big, "b.bin": big }, { level: 9 }), "a.bin", 600_000), "b.bin", 600_000);
    const pkg = new ZipPackage(zip, 1_000_000);
    expect(pkg.bytesOf("a.bin")!.length).toBe(600_000);
    expect(() => pkg.bytesOf("b.bin")).toThrow(/expands to more than/);
  });

  it("assertZipWithinBudget proves a whole archive before a library inflates it", () => {
    const ok = zipSync({ "a.txt": strToU8("hello"), "b.txt": strToU8("world") });
    expect(assertZipWithinBudget(ok)).toBe(10);
    const bomb = zipSync({ "a.bin": new Uint8Array(3_000_000), "b.bin": new Uint8Array(3_000_000) }, { level: 9 });
    expect(() => assertZipWithinBudget(bomb, 4_000_000)).toThrow(CorruptFileError);
  });

  it("rejects truncated archives clearly", () => {
    const zip = zipSync({ "a.txt": strToU8("hello") });
    expect(() => listZip(zip.subarray(0, zip.length - 10))).toThrow(CorruptFileError);
    expect(() => listZip(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]))).toThrow(/end-of-central-directory/);
  });
});
