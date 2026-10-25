// Phone pairing test, step 2: removes (revokes) the paired phone on the PC.
// Usage: node demo/phone-test-revoke.mjs <out-dir>   (same out-dir as phone-test-host.mjs; stop that script first)
import { _electron as electron } from "playwright";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2]);
const env = { ...process.env, UNIVIEW_USER_DATA: join(out, "host-profile") };
delete env.UNIVIEW_TEST_AUTO_APPROVE;
const app = await electron.launch({ args: ["."], cwd: process.cwd(), env });
const h = await app.firstWindow();
await h.getByTestId("open-button").waitFor();
await h.getByTestId("open-sharing").click();
await h.getByText(/reachable at/).waitFor();
await h.screenshot({ path: join(out, "host-before-revoke.png"), fullPage: true });
const t0 = Date.now();
await h.getByRole("button", { name: "Remove" }).first().click();
await h.waitForTimeout(500);
console.log("revoked the device in", Date.now() - t0, "ms");
await h.screenshot({ path: join(out, "host-after-revoke.png"), fullPage: true });
// stay alive so the phone can try again; stop by creating STOP2
const { existsSync } = await import("node:fs");
while (!existsSync(join(out, "STOP2"))) await new Promise((r) => setTimeout(r, 300));
await app.close();
