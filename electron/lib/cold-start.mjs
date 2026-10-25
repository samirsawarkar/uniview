// Packet P27/P27b: shared, pure cold-start command builder (plain Node ESM, no electron imports).
//
// On Windows the app's main process is a GUI-subsystem Electron exe. Unlike a plain Node
// process (which clears inheritance of its own stdio handles at startup), Electron's main
// leaves the CLI caller's stdout/stderr pipe handles inheritable. Every CreateProcess call it
// makes with bInheritHandles=TRUE (what libuv spawn does, and what `cmd.exe /c start` does
// through cmd.exe) hands those pipes to the cold-started app, so a caller reading to EOF hangs
// until the app exits. (P27's `cmd /c start` did not fix this; verified against a packaged build.)
//
// `powershell.exe Start-Process` launches the app with bInheritHandles=FALSE, so the app never
// receives the caller's pipes. The exe and its arguments travel through environment variables,
// never through the PowerShell command text, so no path or argument can inject script.

/**
 * Strips ELECTRON_RUN_AS_NODE from the child environment on cold start
 * so the spawned child runs as the full Electron desktop app rather than Node.
 */
export function cleanSpawnEnv(parentEnv = process.env) {
  const childEnv = { ...parentEnv };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return childEnv;
}

export const COLD_EXE_ENV = "UNIVIEW_COLD_EXE";
export const COLD_ARGS_ENV = "UNIVIEW_COLD_ARGS";

// Fixed script text (no interpolation). Removes its own two variables before launching so the
// app does not inherit them, then starts the app through Start-Process.
export const COLD_START_SCRIPT =
  `$e=$env:${COLD_EXE_ENV};$a=$env:${COLD_ARGS_ENV};` +
  `Remove-Item Env:${COLD_EXE_ENV},Env:${COLD_ARGS_ENV};` +
  `if($a){Start-Process -FilePath $e -ArgumentList $a}else{Start-Process -FilePath $e}`;

// Characters that cannot be carried safely in a command line: quotes (we add our own),
// line breaks and NUL.
const HOSTILE = /["\r\n\0]/;

function assertSafe(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Cold start refused: ${label} must be a non-empty string`);
  }
  if (value.includes('"')) {
    throw new Error(`Cold start refused: hostile character (double quote) in ${label}`);
  }
  if (HOSTILE.test(value)) {
    throw new Error(`Cold start refused: hostile character in ${label}`);
  }
}

function quoteWin(value) {
  // A trailing backslash would escape the closing quote for CommandLineToArgvW: double it.
  return `"${value.replace(/\\+$/, (m) => m + m)}"`;
}

function windowsPowerShell(env) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR || "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/**
 * Builds the {file, args, options} for cold-starting the app detached from the caller.
 * Windows: powershell.exe Start-Process (no inherited handles); exe and args via env vars.
 * Other platforms: direct spawn, unchanged.
 */
export function buildColdStartCommand({
  platform = process.platform,
  execPath = process.execPath,
  args = [],
  env = process.env,
} = {}) {
  const isWin = platform === "win32";
  if (typeof execPath !== "string" || execPath.length === 0) {
    throw new Error("Cold start refused: execPath must be a non-empty string");
  }
  if (execPath.includes('"')) {
    throw new Error("Cold start refused: hostile character (double quote) in execPath");
  }
  const appArgs = Array.isArray(args) ? args : [];
  if (isWin) {
    assertSafe(execPath, "execPath");
    appArgs.forEach((a, i) => assertSafe(a, `args[${i}]`));
    const childEnv = cleanSpawnEnv(env);
    childEnv[COLD_EXE_ENV] = execPath;
    childEnv[COLD_ARGS_ENV] = appArgs.map(quoteWin).join(" ");
    return {
      file: windowsPowerShell(env),
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", COLD_START_SCRIPT],
      options: {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
        env: childEnv,
      },
    };
  }
  return {
    file: execPath,
    args: [...appArgs],
    options: { detached: true, stdio: "ignore", env: cleanSpawnEnv(env) },
  };
}
