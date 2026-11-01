export interface InputEventLike {
  type?: string;
  key?: string;
  code?: string;
  control?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  isAutoRepeat?: boolean;
  [key: string]: unknown;
}

export interface LiveWindowLike {
  isDestroyed?: () => boolean;
  [key: string]: unknown;
}

export function isNewWindowShortcut(input: unknown, platform?: string): boolean;
export function hasOtherLiveWindows(allWindows: unknown, currentWindow?: unknown): boolean;
export function shouldStopAppAgentsOnRenderProcessGone(allWindows: unknown, currentWindow?: unknown): boolean;
