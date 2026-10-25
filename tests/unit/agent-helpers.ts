import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { tmpBase } from "./helpers/tmp-base";

export { createFakeClock, flush } from "./mcp-helpers";

const created: string[] = [];

/** A fresh temp directory (on the I: drive on Windows), removed after the test. */
export async function makeTempDir(prefix = "uv-agent"): Promise<string> {
  const base = tmpBase();
  const dir = path.join(base, `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
  await fs.mkdir(dir, { recursive: true });
  created.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of created.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});
