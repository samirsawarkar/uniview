import { describe, it } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(".");
const MARKER_FILE = join(ROOT, "assets/branding/.regenerate");

describe("dedicated branding generator", () => {
  const shouldRun = process.env.UNIVIEW_GENERATE_ICONS === "1" || existsSync(MARKER_FILE);

  it.skipIf(!shouldRun)(
    "generates branding assets when UNIVIEW_GENERATE_ICONS=1 or marker file exists",
    async () => {
      const { generateAll } = await import("../../scripts/generate-icons.mjs");
      await generateAll();

      if (existsSync(MARKER_FILE)) {
        try {
          unlinkSync(MARKER_FILE);
        } catch {}
      }
    }
  );
});
