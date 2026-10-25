import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { tmpBase } from "./helpers/tmp-base";
// @ts-expect-error plain ESM module without types
import { removeExtraAclEntries, ensureBridgeDir, ensureBridgeKey } from "../../electron/lib/bridge-key.mjs";

const BS = String.fromCharCode(92); // a literal backslash without escape sequences
const SID = "S-1-5-21-1-2-3-1001";
const OWNER = `HOST${BS}runner`;

/**
 * A fake icacls with a mutable ACL. `leftovers` are explicit entries that survive /inheritance:r,
 * as they do for objects created by an elevated process.
 */
function fakeIcacls(leftovers: string[]) {
  const acl = new Map<string, string[]>();
  const calls: string[][] = [];
  const exec = (file: string, args: string[], cb: (e: Error | null, out: string, err: string) => void) => {
    calls.push([file, ...args]);
    const target = args[0]!;
    if (args.length === 1) {
      const lines = acl.get(target) ?? [];
      cb(null, `${target} ${lines.join("\n    ")}\n\nSuccessfully processed 1 files; Failed processing 0 files\n`, "");
      return;
    }
    if (args.includes("/grant:r")) {
      const raw = args[args.length - 1]!.split(":")[1]!;
      const rights = raw === "F" ? "(F)" : raw; // icacls prints a bare F grant as (F)
      acl.set(target, [...leftovers, `${OWNER}:${rights}`]);
    } else if (args.includes("/remove")) {
      const names = args.slice(args.indexOf("/remove") + 1).map((n) => n.toLowerCase());
      acl.set(target, (acl.get(target) ?? []).filter((l) => !names.includes(l.slice(0, l.lastIndexOf(":", l.indexOf("("))).toLowerCase())));
    }
    cb(null, "Successfully processed 1 files; Failed processing 0 files", "");
  };
  return { exec, calls, acl };
}

describe("owner-only ACL on freshly created bridge objects", () => {
  it("removeExtraAclEntries removes explicit non-owner entries and leaves the owner", async () => {
    const f = fakeIcacls([]);
    f.acl.set(`C:${BS}x${BS}dir`, [`NT AUTHORITY${BS}SYSTEM:(OI)(CI)(F)`, `BUILTIN${BS}Administrators:(F)`, `${OWNER}:(OI)(CI)(F)`, `BUILTIN${BS}Users:(I)(OI)(CI)(RX)`, `*S-1-5-99-1:(F)`]);
    await removeExtraAclEntries(`C:${BS}x${BS}dir`, { execFile: f.exec, accountName: OWNER, userSid: SID });
    const removal = f.calls.find((c) => c.includes("/remove"))!;
    expect(removal.slice(3).sort()).toEqual(["*S-1-5-99-1", `BUILTIN${BS}Administrators`, `NT AUTHORITY${BS}SYSTEM`].sort());
    expect(f.acl.get(`C:${BS}x${BS}dir`)).toEqual([`${OWNER}:(OI)(CI)(F)`, `BUILTIN${BS}Users:(I)(OI)(CI)(RX)`]);
  });

  it("makes no change when only the owner is listed", async () => {
    const f = fakeIcacls([]);
    f.acl.set(`C:${BS}x${BS}dir`, [`${OWNER}:(OI)(CI)(F)`]);
    await removeExtraAclEntries(`C:${BS}x${BS}dir`, { execFile: f.exec, accountName: OWNER, userSid: SID });
    expect(f.calls.some((c) => c.includes("/remove"))).toBe(false);
  });

  it("ensureBridgeDir and ensureBridgeKey succeed when the platform leaves explicit Administrators and SYSTEM entries behind", async () => {
    // Mutation: without the prune step the owner-only check throws bad_dir / bad_key_perms for an elevated user.
    const f = fakeIcacls([`BUILTIN${BS}Administrators:(F)`, `NT AUTHORITY${BS}SYSTEM:(F)`]);
    const userDataDir = path.join(tmpBase(), `uv-acl-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
    await fs.mkdir(userDataDir, { recursive: true });
    try {
      const opts = { platform: "win32", execFile: f.exec, accountName: OWNER, userSid: SID };
      const dir = await ensureBridgeDir(userDataDir, opts);
      // The directory carries (OI)(CI)(F); the key file carries (F): neither keeps the extra entries.
      expect(f.acl.get(dir)).toEqual([`${OWNER}:(OI)(CI)F`]);
      const key = await ensureBridgeKey(dir, opts);
      expect(key.length).toBe(32);
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
