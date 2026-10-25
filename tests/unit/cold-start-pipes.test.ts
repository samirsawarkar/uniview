import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTempDir } from "./agent-helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";

describe.skipIf(!isWindows)("Packet P27: cold start pipe leakage on Windows (real process test)", () => {
  let dummyPidToClean: number | null = null;

  afterEach(() => {
    if (dummyPidToClean) {
      try {
        process.kill(dummyPidToClean);
      } catch {}
      dummyPidToClean = null;
    }
  });

  it("Windows cold start does not leak parent stdout pipe to background child", async () => {
    // Mutation: child process inherits caller pipes via direct spawn({detached:true, stdio:'ignore'}) on Windows
    const tempDir = await makeTempDir("cold-start-pipes");
    const pidFile = path.join(tempDir, "dummy.pid");
    const safePidFile = pidFile.replace(/\\/g, "/");

    const coldStartPath = path.resolve(__dirname, "../../electron/lib/cold-start.mjs").replace(/\\/g, "/");
    const coldStartUrl = pathToFileURL(coldStartPath).href;

    // Parent script: runs via node -e, uses buildColdStartCommand to launch a dummy child that writes its PID and sleeps for 30s
    const parentScript = `
      import("${coldStartUrl}").then(({ buildColdStartCommand }) => {
        const { spawn } = require("node:child_process");
        const useOld = process.env.TEST_USE_OLD_SPAWN === "1";
        const dummyCode = "require('fs').writeFileSync('${safePidFile}', String(process.pid)); setTimeout(()=>{},30000);";
        if (useOld) {
          const child = spawn(process.execPath, ["-e", dummyCode], {
            detached: true,
            stdio: "ignore",
          });
          child.unref();
          process.exit(0);
        } else {
          const cmd = buildColdStartCommand({
            platform: "win32",
            execPath: process.execPath,
            args: ["-e", dummyCode],
          });
          const child = spawn(cmd.file, cmd.args, cmd.options);
          child.unref();
          process.exit(0);
        }
      });
    `;

    // Spawn the parent with piped stdout
    const parent = spawn(process.execPath, ["-e", parentScript], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutClosed = false;
    const stdoutClosePromise = new Promise<void>((resolve) => {
      parent.stdout.on("end", () => {
        stdoutClosed = true;
        resolve();
      });
      parent.stdout.on("close", () => {
        stdoutClosed = true;
        resolve();
      });
      parent.on("close", () => {
        stdoutClosed = true;
        resolve();
      });
    });

    // Wait up to 3s for stdout pipe to close
    const timerPromise = new Promise<void>((resolve) => setTimeout(resolve, 3000));
    await Promise.race([stdoutClosePromise, timerPromise]);

    // Parent stdout pipe must reach EOF/'close' within 3 seconds
    expect(stdoutClosed).toBe(true);

    // Read dummy child PID written to pidFile
    let dummyPid: number | null = null;
    const startWait = Date.now();
    while (Date.now() - startWait < 3000) {
      try {
        const raw = await fs.readFile(pidFile, "utf8");
        const p = parseInt(raw.trim(), 10);
        if (!Number.isNaN(p)) {
          dummyPid = p;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(dummyPid).toBeTypeOf("number");
    dummyPidToClean = dummyPid;

    // Verify dummy child is still alive
    let isAlive = false;
    try {
      process.kill(dummyPid!, 0);
      isAlive = true;
    } catch (err: any) {
      if (err.code !== "ESRCH") isAlive = true;
    }
    expect(isAlive).toBe(true);

    // Clean up dummy child immediately
    try {
      process.kill(dummyPid!);
    } catch {}
    dummyPidToClean = null;
  });
});
