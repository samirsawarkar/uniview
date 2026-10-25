// Rehearses the whole board demo against the PACKAGED app and saves screenshots to demo/shots.
// Run: node demo/rehearse.mjs [path-to-UniView.exe]
import { _electron as electron } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const exe = process.argv[2] || join(root, "release-candidate", "win-unpacked", "UniView.exe");
const shots = join(here, "shots");
mkdirSync(shots, { recursive: true });

spawnSync(process.execPath, [join(here, "make-demo.mjs")], { stdio: "inherit" });

const app = await electron.launch({ executablePath: exe, args: [] });
const page = await app.firstWindow();
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(1500);
await page.screenshot({ path: join(shots, "1-home.png") });

// Open files the normal way (what double-clicking or dragging them does).
const filesDir = join(here, "files");
const names = ["report.pdf", "charter.docx", "deck.pptx", "sales.xlsx", "notes.md", "app.ts"];
spawnSync(exe, names.map((n) => join(filesDir, n)), { encoding: "utf8" });
await page.waitForTimeout(3000);
for (const n of names) {
  await page.locator(".tab", { hasText: n }).first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(shots, `file-${n}.png`) });
}

// An "assistant" asks for a review and waits for the decision.
const review = spawn(exe, ["open", "--wait", "--timeout", "120", "--receipt", join(here, "demo-review.receipt.json"), join(filesDir, "sales.xlsx")], { stdio: ["ignore", "pipe", "pipe"] });
let out = "";
review.stdout.on("data", (d) => (out += d));
review.stderr.on("data", (d) => (out += d));
const exited = new Promise((res) => review.on("exit", (code) => res(code)));

await page.getByText("Content from the agent").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: join(shots, "3-review.png") });
const approve = page.getByRole("button", { name: /^approve/i }).first();
await approve.waitFor({ timeout: 10000 });
await page.waitForTimeout(800);
await approve.click();
await page.waitForTimeout(1000);
await page.screenshot({ path: join(shots, "4-approved.png") });
const code = await exited;
console.log("assistant got exit code", code);
console.log(out.trim().slice(0, 800));
await app.close();
