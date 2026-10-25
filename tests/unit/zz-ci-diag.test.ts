import { it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

it("CI-DIAG icacls", () => {
  if (process.platform !== "win32") return;
  const run = (c: string, a: string[]) => { try { return execFileSync(c, a, { encoding: "utf8" }); } catch (e: any) { return "ERR " + e.message; } };
  const who = run("whoami", ["/user", "/fo", "csv", "/nh"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-"));
  const sid = (who.trim().split(",")[1] ?? "").replace(/"/g, "");
  const out1 = run("icacls", [dir]);
  const grant = run("icacls", [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`]);
  const out2 = run("icacls", [dir]);
  const real = fs.realpathSync.native(dir);
  console.log("CI-DIAG whoami=" + who + "\ndir=" + dir + " real=" + real + "\nBEFORE:\n" + out1 + "\nGRANT:\n" + grant + "\nAFTER:\n" + out2 + "\nGROUPS:\n" + run("whoami", ["/groups", "/fo", "csv", "/nh"]).slice(0, 600));
});
