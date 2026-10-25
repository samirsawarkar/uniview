// Live MCP test, PC side: runs the packaged app and answers the agent-approval dialog with "Allow for this session"
// (the dialog is stubbed from the test side only; the product has no test hook).
// Usage: node demo/mcp-live-host.mjs <UniView.exe> <out-dir>      stop with <out-dir>/STOP
import { _electron as electron } from "playwright";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const exe = resolve(process.argv[2]);
const out = resolve(process.argv[3]);
mkdirSync(out, { recursive: true });
const log = (s) => appendFileSync(join(out, "mcp-host.log"), `${new Date().toISOString()} ${s}\n`);

const app = await electron.launch({ executablePath: exe, args: [] });
const page = await app.firstWindow();
await page.waitForLoadState("domcontentloaded");
await app.evaluate(({ dialog }) => {
  globalThis.__approvals = [];
  const orig = dialog.showMessageBox.bind(dialog);
  dialog.showMessageBox = async (...args) => {
    const opts = args.length > 1 ? args[1] : args[0];
    globalThis.__approvals.push({ message: String(opts?.message ?? "").slice(0, 200), buttons: opts?.buttons });
    return { response: 0, checkboxChecked: false }; // Allow for this session
  };
  globalThis.__origShowMessageBox = orig;
});
log("app up, approval dialog stubbed to 'Allow for this session'");
let last = 0;
while (!existsSync(join(out, "STOP"))) {
  const n = await app.evaluate(() => globalThis.__approvals.length);
  if (n !== last) {
    const items = await app.evaluate(() => JSON.stringify(globalThis.__approvals));
    log("approval dialogs so far: " + items);
    last = n;
    await page.screenshot({ path: join(out, `mcp-host-${n}.png`) });
  }
  // act as the person: when a review appears, wait past the 500 ms arming delay and click Approve with a real click
  const approve = page.getByRole("button", { name: /^approve/i }).first();
  if ((await approve.isVisible().catch(() => false)) && (await approve.isEnabled().catch(() => false))) {
    await page.screenshot({ path: join(out, "mcp-host-review.png") });
    await page.waitForTimeout(1200);
    await approve.click();
    log("clicked Approve on the review");
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(out, "mcp-host-approved.png") });
  }
  await new Promise((r) => setTimeout(r, 400));
}
await page.screenshot({ path: join(out, "mcp-host-final.png") });
await app.close();
