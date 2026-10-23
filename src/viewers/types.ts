import type { Detection, FileSource } from "../core/types";

export interface ViewerProps {
  source: FileSource;
  detection: Detection;
  /** Call once the first meaningful content is on screen (used for time-to-first-view). */
  onReady: () => void;
  /** Open more files in new tabs (archive entries). */
  onOpen: (files: FileSource[]) => void;
}

/** Size above which in-memory parsers refuse and offer the hex view instead. */
export const MAX_IN_MEMORY = 512 * 1024 * 1024;
