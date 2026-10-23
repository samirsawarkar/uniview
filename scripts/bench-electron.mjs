// Process-family memory benchmark for the Electron shell.
// Usage: node scripts/bench-electron.mjs [fixture]
import { _electron as electron } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FX = join(root, "fixtures", "generated");
const fixtureName = process.argv[2] ?? "big.xlsx";
const fixturePath = join(FX, fixtureName);

const app = await electron.launch({ args: [".", fixturePath], cwd: root });
let totalMB = "0.0";
try {
  const page = await app.firstWindow();
  await page.waitForFunction(
    (n) => (window.__univiewMetrics ?? []).some((m) => m.name === n),
    fixtureName,
    { timeout: 30_000 },
  );

  const metrics = await app.evaluate(({ app }) => app.getAppMetrics());
  const totalKB = metrics.reduce((acc, m) => acc + (m.memory?.workingSetSize ?? 0), 0);
  totalMB = (totalKB / 1024).toFixed(1);
  console.log(`Electron process-family memory after open (${fixtureName}): ${totalMB} MB (${metrics.length} processes)`);
} finally {
  await app.close();
}

const benchFile = join(root, "docs", "BENCHMARK.md");
try {
  let content = readFileSync(benchFile, "utf8");
  const line = `Electron process-family memory after open (${fixtureName}): ${totalMB} MB.`;
  if (/Electron process-family memory[^\n]*/.test(content)) {
    content = content.replace(/Electron process-family memory[^\n]*/, line);
  } else {
    const targetIdx = content.indexOf("Targets from docs/SPEC.md:");
    if (targetIdx !== -1) {
      content = content.slice(0, targetIdx) + line + "\n\n" + content.slice(targetIdx);
    } else {
      content = content.trimEnd() + "\n\n" + line + "\n";
    }
  }
  writeFileSync(benchFile, content);
  console.log(`Updated ${benchFile} with Electron memory.`);
} catch (err) {
  console.warn(`Could not update ${benchFile}:`, err.message);
}
