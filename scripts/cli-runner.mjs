// Standalone entry for the `UniView open` client: runs electron/lib/cli.mjs against the real bridge
// client with the real key files, without Electron. Used by the process-level test
// (tests/unit/cli-process.test.ts) and handy for trying the CLI against a running bridge server.
//
//   UNIVIEW_USER_DATA=<userData dir> node scripts/cli-runner.mjs open [options] <file>...
//
// The packaged app wires the same runCli in electron/main.mjs with its own userData folder and a real
// app launcher; this runner has no launcher, so an unreachable bridge is reported at once (exit 6).
// It never calls process.exit: the process ends by itself when runCli's timers and the socket are released.

import path from "node:path";
import { runCli } from "../electron/lib/cli.mjs";
import { connectBridge } from "../electron/lib/bridge-client.mjs";
import { readBridgeKey, ensureInstallId, windowsUserSid, bridgeEndpoint } from "../electron/lib/bridge-key.mjs";

const userData = process.env.UNIVIEW_USER_DATA;
if (!userData) {
  process.stderr.write("UniView: UNIVIEW_USER_DATA is not set\n");
  process.exitCode = 2;
} else {
  const bridgeDir = path.join(userData, "bridge");

  const connect = async () => {
    const key = await readBridgeKey(bridgeDir);
    const endpoint =
      process.platform === "win32"
        ? bridgeEndpoint({ bridgeDir, userSid: await windowsUserSid(), installId: await ensureInstallId(bridgeDir) })
        : bridgeEndpoint({ bridgeDir });
    return connectBridge({ endpoint, key });
  };

  const startApp = async () => {
    throw new Error("this runner has no app launcher");
  };

  process.exitCode = await runCli({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    connect,
    startApp,
  });
}
