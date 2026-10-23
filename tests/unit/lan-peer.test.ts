import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module without types
import { isLanPeer } from "../../electron/lib/share-host.mjs";

describe("isLanPeer", () => {
  it("allows private and local network peer addresses", () => {
    const allowed = [
      "127.0.0.1",
      "::1",
      "::ffff:192.168.1.51",
      "192.168.1.51",
      "10.0.0.7",
      "fe80::1%2",
      "fd00::5",
    ];
    for (const addr of allowed) {
      expect(isLanPeer(addr), `expected ${addr} to be allowed`).toBe(true);
    }
  });

  it("rejects non-LAN, public, CGNAT, link-local IPv4, empty, and undefined addresses", () => {
    const rejected = [
      "8.8.8.8",
      "::ffff:8.8.8.8",
      "203.0.113.9",
      "100.64.0.1",
      "169.254.1.1",
      "",
      undefined,
    ];
    for (const addr of rejected) {
      expect(isLanPeer(addr), `expected ${String(addr)} to be rejected`).toBe(false);
    }
  });
});
