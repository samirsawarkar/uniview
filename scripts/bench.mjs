// Time-to-first-view benchmark. Needs the production build served by `npm run preview` (port 4173).
// Usage: node scripts/bench.mjs [--runs 5]
import { chromium } from "@playwright/test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FX = join(root, "fixtures", "generated");
const URL = process.env.UNIVIEW_URL ?? "http://localhost:4173/";
const runs = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 5;
const SKIP = new Set(["broken.pdf", "broken.docx", "broken.zip", "random.bin", "empty.txt"]);
const files = readdirSync(FX).filter((f) => !SKIP.has(f)).sort();

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function openAndMeasure(page, name, nth) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await (await chooser).setFiles(join(FX, name));
  const handle = await page.waitForFunction(
    ([n, k]) => (window.__univiewMetrics ?? []).filter((m) => m.name === n)[k]?.ms,
    [name, nth],
    { timeout: 30_000 },
  );
  return handle.jsonValue();
}

const browser = await chromium.launch();
const results = [];
const startTimes = [];
try {
  for (let i = 0; i < runs; i++) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const t0 = Date.now();
    await page.goto(URL);
    await page.getByTestId("open-button").waitFor();
    startTimes.push(Date.now() - t0);
    await page.close();
  }
  for (const name of files) {
    const cold = [];
    const warm = [];
    const coldHeaps = [];
    const coldTasks = [];
    for (let i = 0; i < runs; i++) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(URL);
      await page.evaluate(() => {
        window.__maxLongTask = 0;
        const obs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > (window.__maxLongTask || 0)) window.__maxLongTask = entry.duration;
          }
        });
        obs.observe({ entryTypes: ["longtask"] });
      });
      cold.push(await openAndMeasure(page, name, 0));
      const maxTask = await page.evaluate(() => Math.round(window.__maxLongTask || 0));
      coldTasks.push(maxTask);
      try {
        const client = await page.context().newCDPSession(page);
        await client.send("Performance.enable");
        const { metrics } = await client.send("Performance.getMetrics");
        const heap = metrics.find((m) => m.name === "JSHeapUsedSize");
        if (heap) coldHeaps.push(heap.value / (1024 * 1024));
        await client.detach();
      } catch {
        /* CDP session error ignored */
      }
      await page.close();
    }
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(URL);
    await openAndMeasure(page, name, 0);
    for (let i = 1; i <= runs; i++) warm.push(await openAndMeasure(page, name, i));
    await page.close();
    const heapMB = coldHeaps.length ? pct(coldHeaps, 50).toFixed(1) : "0.0";
    const taskMs = coldTasks.length ? Math.round(pct(coldTasks, 50)) : 0;
    results.push({ name, size: statSync(join(FX, name)).size, cold, warm, heap: heapMB, longestTask: taskMs });
    console.log(`${name.padEnd(14)} cold p50 ${pct(cold, 50)} ms  warm p50 ${pct(warm, 50)} ms  heap ${heapMB} MB  longest task ${taskMs} ms`);
  }
} finally {
  await browser.close();
}

let electronLine = "";
try {
  const prev = readFileSync(join(root, "docs", "BENCHMARK.md"), "utf8");
  const m = prev.match(/Electron process-family memory[^\n]*/);
  if (m) electronLine = m[0];
} catch {
  /* no prior benchmark file */
}

const allWarm = results.flatMap((r) => r.warm);
const allCold = results.flatMap((r) => r.cold);
const lines = [
  "# UniView benchmark",
  "",
  `Generated ${new Date().toISOString()} by \`npm run bench\` (${runs} runs each, Chromium headless, production build, ${process.platform}).`,
  "Time-to-first-view: from the file entering the app to the first meaningful content painted (two animation frames after the viewer reports content).",
  "Cold = first open of that format in a fresh page (includes loading the viewer's code). Warm = reopening in the same page.",
  "",
  `App start to interactive (page load to Open button): p50 ${pct(startTimes, 50)} ms, p95 ${pct(startTimes, 95)} ms.`,
  "",
  `All formats: cold p50 ${pct(allCold, 50)} ms, p95 ${pct(allCold, 95)} ms · warm p50 ${pct(allWarm, 50)} ms, p95 ${pct(allWarm, 95)} ms.`,
  "",
  "| File | Size | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Heap after open | Longest task |",
  "|---|---:|---:|---:|---:|---:|---:|---:|",
  ...results.map((r) => `| ${r.name} | ${(r.size / 1024).toFixed(1)} KB | ${pct(r.cold, 50)} ms | ${pct(r.cold, 95)} ms | ${pct(r.warm, 50)} ms | ${pct(r.warm, 95)} ms | ${r.heap} MB | ${r.longestTask} ms |`),
  "",
  ...(electronLine ? [electronLine, ""] : []),
  "Targets from docs/SPEC.md: warm p50 under 300 ms for files under 5 MB; app start under 1.5 s.",
];
writeFileSync(join(root, "docs", "BENCHMARK.md"), lines.join("\n") + "\n");
console.log(`\nApp start p50 ${pct(startTimes, 50)} ms · all cold p50 ${pct(allCold, 50)} ms · all warm p50 ${pct(allWarm, 50)} ms`);
console.log("Wrote docs/BENCHMARK.md");
