import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-ignore - scripts/bench-metrics.mjs is an ES module
import { getHeapMeasurement } from "../../scripts/bench-metrics.mjs";

describe("getHeapMeasurement", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns heap used in MB and detaches client on successful metric", async () => {
    const fakeClient = {
      send: vi.fn().mockImplementation(async (method: string) => {
        if (method === "Performance.enable") return {};
        if (method === "Performance.getMetrics") {
          return {
            metrics: [
              { name: "Documents", value: 4 },
              { name: "JSHeapUsedSize", value: 16 * 1024 * 1024 },
            ],
          };
        }
        return {};
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };

    const fakePage = {
      context: () => ({
        newCDPSession: vi.fn().mockResolvedValue(fakeClient),
      }),
    };

    const result = await getHeapMeasurement(fakePage as any);

    expect(result).toBe(16);
    expect(fakeClient.send).toHaveBeenCalledWith("Performance.enable");
    expect(fakeClient.send).toHaveBeenCalledWith("Performance.getMetrics");
    expect(fakeClient.detach).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns null, logs warning, and detaches client when JSHeapUsedSize is missing", async () => {
    const fakeClient = {
      send: vi.fn().mockImplementation(async (method: string) => {
        if (method === "Performance.enable") return {};
        if (method === "Performance.getMetrics") {
          return {
            metrics: [{ name: "Documents", value: 4 }],
          };
        }
        return {};
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };

    const fakePage = {
      context: () => ({
        newCDPSession: vi.fn().mockResolvedValue(fakeClient),
      }),
    };

    const result = await getHeapMeasurement(fakePage as any);

    expect(result).toBeNull();
    expect(fakeClient.detach).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("JSHeapUsedSize metric missing"));
  });

  it("returns null and logs warning when newCDPSession rejects", async () => {
    const fakePage = {
      context: () => ({
        newCDPSession: vi.fn().mockRejectedValue(new Error("CDP session creation failed")),
      }),
    };

    const result = await getHeapMeasurement(fakePage as any);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("CDP session creation failed"));
  });

  it("returns null, logs warning, and detaches client when client.send rejects", async () => {
    const fakeClient = {
      send: vi.fn().mockRejectedValue(new Error("Performance.enable failed")),
      detach: vi.fn().mockResolvedValue(undefined),
    };

    const fakePage = {
      context: () => ({
        newCDPSession: vi.fn().mockResolvedValue(fakeClient),
      }),
    };

    const result = await getHeapMeasurement(fakePage as any);

    expect(result).toBeNull();
    expect(fakeClient.detach).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Performance.enable failed"));
  });

  it("detaches client in finally even when client.send throws an error", async () => {
    const fakeClient = {
      send: vi.fn().mockImplementation(async (method: string) => {
        if (method === "Performance.enable") return {};
        throw new Error("Performance.getMetrics error");
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };

    const fakePage = {
      context: () => ({
        newCDPSession: vi.fn().mockResolvedValue(fakeClient),
      }),
    };

    const result = await getHeapMeasurement(fakePage as any);

    expect(result).toBeNull();
    expect(fakeClient.detach).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Performance.getMetrics error"));
  });

  it("catches and logs warning if detach itself rejects", async () => {
    const fakeClient = {
      send: vi.fn().mockRejectedValue(new Error("send failed")),
      detach: vi.fn().mockRejectedValue(new Error("detach failed")),
    };

    const fakePage = {
      context: () => ({
        newCDPSession: vi.fn().mockResolvedValue(fakeClient),
      }),
    };

    const result = await getHeapMeasurement(fakePage as any);

    expect(result).toBeNull();
    expect(fakeClient.detach).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("send failed"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("detach failed"));
  });
});
