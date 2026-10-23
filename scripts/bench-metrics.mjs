/**
 * Measures the V8 JS heap used size in MB for the given page via Chrome DevTools Protocol.
 * Returns number (in MB) on success, or null on failure / missing metric.
 * Client is always detached in finally.
 * Failures are logged to stderr to ensure visibility.
 *
 * @param {any} page - Playwright Page object or mock
 * @returns {Promise<number | null>} Used JS heap in MB, or null
 */
export async function getHeapMeasurement(page) {
  let client = null;
  try {
    client = await page.context().newCDPSession(page);
    await client.send("Performance.enable");
    const { metrics } = await client.send("Performance.getMetrics");
    const heap = metrics?.find?.((m) => m.name === "JSHeapUsedSize");
    if (heap && typeof heap.value === "number" && Number.isFinite(heap.value) && heap.value >= 0) {
      return heap.value / (1024 * 1024);
    }
    console.warn("[bench-metrics] JSHeapUsedSize metric missing");
    return null;
  } catch (err) {
    console.warn(`[bench-metrics] CDP heap measurement failed: ${(err && err.message) || err}`);
    return null;
  } finally {
    if (client) {
      try {
        await client.detach();
      } catch (detachErr) {
        console.warn(`[bench-metrics] CDP client detach failed: ${(detachErr && detachErr.message) || detachErr}`);
      }
    }
  }
}
