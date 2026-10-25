// Checks that files opened by the command line stay readable after the command has exited.
// Run: node demo/verify-cli-open.mjs [path-to-UniView.exe]
import { _electron as electron } from "playwright";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const exe = process.argv[2] || join(resolve(here, ".."), "release-candidate", "win-unpacked", "UniView.exe");
const shots = join(here, "shots");
mkdirSync(shots, { recursive: true });
const filesDir = join(here, "files");
const names = ["report.pdf", "charter.docx", "deck.pptx", "sales.xlsx"];

const app = await electron.launch({ executablePath: exe, args: [] });
const page = await app.firstWindow();
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(1500);
const r = spawnSync(exe, ["open", ...names.map((n) => join(filesDir, n))], { encoding: "utf8" });
console.log("CLI exit", r.status);
await page.waitForTimeout(4000); // the command has exited by now
let bad = 0;
for (const n of names) {
  await page.locator(".tab", { hasText: n }).first().click();
  await page.waitForTimeout(1200);
  const failed = await page.getByText("could not be displayed").count();
  console.log(n, failed ? "FAILED to display" : "ok");
  bad += failed;
  await page.screenshot({ path: join(shots, `cli-${n}.png`) });
}
await app.close();
process.exit(bad ? 1 : 0);
