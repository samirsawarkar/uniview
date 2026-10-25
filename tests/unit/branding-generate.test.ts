import { describe, it } from "vitest";

describe("dedicated branding generator", () => {
  it.skipIf(process.env.UNIVIEW_GENERATE_ICONS !== "1")(
    "generates branding assets when UNIVIEW_GENERATE_ICONS=1",
    async () => {
      const { generateAll } = await import("../../scripts/generate-icons.mjs");
      await generateAll();
    }
  );
});
