import { it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

it("CI-DIAG icacls", () => {
  if (process.platform !== "win32") return;
  const run = (c: string, a: string[]) => { try { return execFileSync(c, a, { encoding: "utf8" }); } catch (e: any) { return "ERR " + e.message; } };
  const who = run("whoami", ["/user", "/fo", "csv", "/nh"]);
  const sid = (who.trim().split(",")[1] ?? "").replace(/"/g, "");
  const out: string[] = ["CI-DIAG who=" + who, "tmpdir=" + os.tmpdir() + " RUNNER_TEMP=" + process.env.RUNNER_TEMP + " APPDATA=" + process.env.APPDATA + " cwd=" + process.cwd()];
  out.push("PARENT TEMP:\n" + run("icacls", [os.tmpdir()]));
  out.push("PARENT cwd:\n" + run("icacls", [process.cwd()]));
  for (const [label, base] of [["tmpdir", os.tmpdir()], ["cwd", process.cwd()], ["runnertemp", process.env.RUNNER_TEMP ?? os.tmpdir()]] as const) {
    const dir = fs.mkdtempSync(path.join(base, "diag-"));
    out.push(`== ${label} ${dir}\nBEFORE:\n` + run("icacls", [dir]));
    out.push("GRANT:\n" + run("icacls", [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`]));
    out.push("AFTER grant:\n" + run("icacls", [dir]));
    out.push("REMOVE:\n" + run("icacls", [dir, "/remove:g", "*S-1-5-18", "*S-1-5-32-544"]));
    out.push("AFTER remove:\n" + run("icacls", [dir]));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(out.join("\n"));
});
