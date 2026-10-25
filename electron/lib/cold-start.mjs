// Packet P27: shared, pure cold-start command builder (plain Node ESM, no electron imports).
//
// On Windows a CreateProcess call made by the app's main process inherits the parent's
// inheritable handles, including the CLI caller's stdout/stderr pipes. A cold-started app
// that is launched through plain spawn({detached, stdio:'ignore'}) therefore keeps the
// caller's pipes open and any caller reading to EOF hangs. `cmd.exe /c start` creates the
// process via ShellExecute, which does not inherit those handles.

/**
 * Strips ELECTRON_RUN_AS_NODE from the child environment on cold start
 * so the spawned child runs as the full Electron desktop app rather than Node.
 */
export function cleanSpawnEnv(parentEnv = process.env) {
  const childEnv = { ...parentEnv };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return childEnv;
}

// Characters that cmd.exe expands or interprets even inside double quotes, plus line breaks.
const HOSTILE_WIN = /["%!^&\r\n\0]/;

function assertSafe(value, label, { allowCmdChars }) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Cold start refused: ${label} must be a non-empty string`);
  }
  if (value.includes('"')) {
    throw new Error(`Cold start refused: hostile character (double quote) in ${label}`);
  }
  if (!allowCmdChars && HOSTILE_WIN.test(value)) {
    throw new Error(`Cold start refused: hostile character in ${label}`);
  }
}

function quoteWin(value) {
  // A trailing backslash would escape the closing quote for CommandLineToArgvW: double it.
  return `"${value.replace(/\+$/, (m) => m + m)}"`;
}

/**
 * Builds the {file, args, options} for cold-starting the app detached from the caller.
 * Windows: cmd.exe /d /s /c start "" "<exe>" "<arg>"... (no inherited handles).
 * Other platforms: direct spawn, unchanged.
 */
export function buildColdStartCommand({
  platform = process.platform,
  execPath = process.execPath,
  args = [],
  env = process.env,
} = {}) {
  const isWin = platform === "win32";
  assertSafe(execPath, "execPath", { allowCmdChars: !isWin });
  const appArgs = Array.isArray(args) ? args : [];
  if (isWin) {
    appArgs.forEach((a, i) => assertSafe(a, `args[${i}]`, { allowCmdChars: false }));
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", "start", '""', quoteWin(execPath), ...appArgs.map(quoteWin)],
      options: {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: true,
        env: cleanSpawnEnv(env),
      },
    };
  }
  return {
    file: execPath,
    args: [...appArgs],
    options: { detached: true, stdio: "ignore", env: cleanSpawnEnv(env) },
  };
}
