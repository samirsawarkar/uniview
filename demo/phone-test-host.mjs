// Runs the PC side of the phone pairing test: shares a folder, shows the pairing offer, clicks Allow when the phone asks.
// Usage: node demo/phone-test-host.mjs <folder-to-share> <out-dir>      (stop it by creating <out-dir>/STOP)
// Writes: <out-dir>/pair-code.txt, <out-dir>/host.log, <out-dir>/host-*.png
import { _electron as electron } from "playwright";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const share = resolve(process.argv[2]);
const out = resolve(process.argv[3]);
mkdirSync(out, { recursive: true });
const log = (s) => appendFileSync(join(out, "host.log"), `${new Date().toISOString()} ${s}\n`);
const env = { ...process.env, UNIVIEW_USER_DATA: join(out, "host-profile"), UNIVIEW_TEST_PICK_DIR: share };
delete env.UNIVIEW_TEST_AUTO_APPROVE;

const app = await electron.launch({ args: ["."], cwd: process.cwd(), env });
const h = await app.firstWindow();
await h.getByTestId("open-button").waitFor();
await h.getByTestId("open-sharing").click();
await h.getByTestId("sharing-toggle").check();
await h.getByText(/reachable at/).waitFor();
log("reachable: " + (await h.getByText(/reachable at/).innerText()));
await h.getByTestId("add-folder").click();
await h.getByTestId("permission-screen").waitFor();
await h.getByTestId("confirm-share").click();
await h.getByTestId("pair-device").click();
const code = await h.getByTestId("pair-code").inputValue();
writeFileSync(join(out, "pair-code.txt"), code);
await h.screenshot({ path: join(out, "host-offer.png") });
log("pairing code written (" + code.length + " chars)");

let shot = 0;
for (;;) {
  if (existsSync(join(out, "STOP"))) break;
  // the host asks the person to allow a new device: click Allow like a person would
  const allow = h.getByRole("button", { name: /^allow/i }).first();
  if (await allow.isVisible().catch(() => false)) {
    await h.screenshot({ path: join(out, `host-allow-${shot++}.png`) });
    log("allow prompt shown, clicking Allow");
    await allow.click();
    await h.waitForTimeout(500);
    await h.screenshot({ path: join(out, `host-allowed-${shot++}.png`) });
  }
  await new Promise((r) => setTimeout(r, 300));
}
await h.screenshot({ path: join(out, "host-final.png") });
await app.close();
