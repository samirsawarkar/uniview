import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Decision 20261023T061049567396Z-d3f9d814: the viewer core stays shell-agnostic so the shell can be swapped
// (Tauri gate before signing). Only src/shells may talk to a shell runtime.
const FORBIDDEN = /from\s+["'](electron|@capacitor\/[^"']+|@tauri-apps\/[^"']+)["']|require\(\s*["'](electron|@capacitor|@tauri-apps)/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe("architecture fence", () => {
  for (const dir of ["src/core", "src/viewers", "src/ui"]) {
    it(`${dir} imports no shell runtime`, () => {
      const offenders = files(dir).filter((f) => FORBIDDEN.test(readFileSync(f, "utf8")));
      expect(offenders).toEqual([]);
    });
  }
  it("src/core imports no React", () => {
    expect(files("src/core").filter((f) => /from\s+["']react/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
