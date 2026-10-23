import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" lets the same build load from file://, uniview://app/ and the Capacitor WebView.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
  },
  worker: { format: "es" },
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
  },
});
