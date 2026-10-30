// Pure helpers for Electron window lifecycle and shortcut management.
// No electron imports, so they are unit-testable.

/**
 * Matches Ctrl+N (or Cmd+N on macOS) keydown shortcuts from WebContents before-input-event.
 *
 * @param {object} input - Electron before-input-event input object
 * @param {string} [platform=process.platform] - OS platform
 * @returns {boolean}
 */
export function isNewWindowShortcut(input, platform = process.platform) {
  if (!input || typeof input !== "object") return false;
  if (input.type !== "keyDown" && input.type !== "keydown") return false;
  if (input.isAutoRepeat) return false;
  if (input.alt || input.shift) return false;

  const key = typeof input.key === "string" ? input.key.toLowerCase() : "";
  const code = typeof input.code === "string" ? input.code : "";
  if (key !== "n" && code !== "KeyN") return false;

  if (platform === "darwin") {
    return Boolean(input.meta && !input.control);
  }
  return Boolean(input.control && !input.meta);
}

/**
 * Checks whether any live (non-destroyed) window remains among allWindows other than currentWindow.
 *
 * @param {Array<any>} allWindows - List of windows (e.g. from BrowserWindow.getAllWindows())
 * @param {any} [currentWindow] - The window to exclude (e.g. crashing or closing window)
 * @returns {boolean}
 */
export function hasOtherLiveWindows(allWindows, currentWindow) {
  if (!Array.isArray(allWindows)) return false;
  return allWindows.some((candidate) => {
    if (!candidate || candidate === currentWindow) return false;
    if (typeof candidate.isDestroyed === "function" && candidate.isDestroyed()) return false;
    return true;
  });
}

/**
 * Decides whether appAgents should be stopped when a window's render process is gone.
 * Returns true only when no other live window remains.
 *
 * @param {Array<any>} allWindows - List of windows (e.g. from BrowserWindow.getAllWindows())
 * @param {any} [currentWindow] - The window experiencing render-process-gone
 * @returns {boolean}
 */
export function shouldStopAppAgentsOnRenderProcessGone(allWindows, currentWindow) {
  return !hasOtherLiveWindows(allWindows, currentWindow);
}
