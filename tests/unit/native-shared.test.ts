// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sharedSource, SHARED_SPAN } from "../../src/shells/native-shared";
import { installNativeOpenHook } from "../../src/shells/index";
import type { FileSource } from "../../src/core/types";

describe("native-shared", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exports SHARED_SPAN as 8 MiB", () => {
    expect(SHARED_SPAN).toBe(8 * 1024 * 1024);
  });

  it("requests correct URLs and chunking for a 20 MiB read (8+8+4 MiB)", async () => {
    const requestedUrls: string[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      requestedUrls.push(url);
      const parsed = new URL(url, "https://localhost");
      const start = Number(parsed.searchParams.get("start"));
      const end = Number(parsed.searchParams.get("end"));
      const length = end - start;
      const buf = new Uint8Array(length);
      buf.fill(start % 256);
      return Promise.resolve({
        status: 200,
        ok: true,
        arrayBuffer: () => Promise.resolve(buf.buffer),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const totalSize = 30 * 1024 * 1024;
    const source = sharedSource("token123", "large-video.mp4", totalSize, "video/mp4");

    const readSize = 20 * 1024 * 1024;
    const buffer = await source.readRange(0, readSize);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(requestedUrls).toEqual([
      "/_uniview_shared/token123?start=0&end=8388608",
      "/_uniview_shared/token123?start=8388608&end=16777216",
      "/_uniview_shared/token123?start=16777216&end=20971520",
    ]);
    expect(buffer.byteLength).toBe(20 * 1024 * 1024);
  });

  it("clamps end at size", async () => {
    const requestedSpans: { start: number; end: number }[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const parsed = new URL(url, "https://localhost");
      const start = Number(parsed.searchParams.get("start"));
      const end = Number(parsed.searchParams.get("end"));
      requestedSpans.push({ start, end });
      const length = end - start;
      return Promise.resolve({
        status: 200,
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(length)),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const fileSize = 10 * 1024 * 1024;
    const source = sharedSource("tokenClamp", "video.mp4", fileSize, "video/mp4");

    const buffer = await source.readRange(0, 15 * 1024 * 1024);

    expect(requestedSpans).toEqual([
      { start: 0, end: 8 * 1024 * 1024 },
      { start: 8 * 1024 * 1024, end: 10 * 1024 * 1024 },
    ]);
    expect(buffer.byteLength).toBe(10 * 1024 * 1024);
  });

  it("returns empty result when start >= size without making requests", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const source = sharedSource("tokenEmpty", "doc.pdf", 1000, "application/pdf");

    const bufAtSize = await source.readRange(1000, 2000);
    expect(bufAtSize.byteLength).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();

    const bufPastSize = await source.readRange(1500, 2000);
    expect(bufPastSize.byteLength).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();

    const bufReversed = await source.readRange(500, 400);
    expect(bufReversed.byteLength).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws error with the file name on non-200 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
    vi.stubGlobal("fetch", mockFetch);

    const source = sharedSource("tokenErr", "presentation.pptx", 5000, "application/vnd.ms-powerpoint");

    await expect(source.readRange(0, 1000)).rejects.toThrow('Could not read "presentation.pptx" (HTTP 404)');
  });

  it("stops further requests when abort signal is triggered", async () => {
    const controller = new AbortController();
    let calls = 0;

    const mockFetch = vi.fn().mockImplementation(() => {
      calls++;
      controller.abort();
      return Promise.resolve({
        status: 200,
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8 * 1024 * 1024)),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const totalSize = 30 * 1024 * 1024;
    const source = sharedSource("tokenAbort", "movie.mov", totalSize, "video/quicktime");

    await expect(source.readRange(0, 20 * 1024 * 1024, controller.signal)).rejects.toThrow();
    expect(calls).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not request when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const source = sharedSource("tokenPreAbort", "test.bin", 10000, "application/octet-stream");

    await expect(source.readRange(0, 5000, controller.signal)).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends close request exactly once even if release is called twice", () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 204,
      ok: true,
    });
    vi.stubGlobal("fetch", mockFetch);

    const source = sharedSource("tokenRel", "archive.zip", 1000, "application/zip", "https://localhost");

    source.release();
    source.release();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith("https://localhost/_uniview_shared/tokenRel?close=1");
  });

  it("reads [0, size) via readAll", async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const parsed = new URL(url, "https://localhost");
      const start = Number(parsed.searchParams.get("start"));
      const end = Number(parsed.searchParams.get("end"));
      return Promise.resolve({
        status: 200,
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(end - start)),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const source = sharedSource("tokenAll", "all.dat", 4000, "application/octet-stream");
    const buf = await source.readAll();

    expect(buf.byteLength).toBe(4000);
    expect(mockFetch).toHaveBeenCalledWith("/_uniview_shared/tokenAll?start=0&end=4000");
  });

  it("delivers calls queued in window.__univiewPendingShared before installNativeOpenHook", () => {
    const w = window as unknown as {
      __univiewOpen?: (files: unknown[]) => void;
      __univiewOpenError?: (message: string) => void;
      __univiewOpenShared?: (token: string, name: string, size: number, mime: string) => void;
      __univiewPendingShared?: { token: string; name: string; size: number; mime: string }[];
    };

    const openedFiles: FileSource[] = [];
    w.__univiewOpen = vi.fn((files: unknown[]) => {
      openedFiles.push(...(files as FileSource[]));
    });

    w.__univiewPendingShared = [
      { token: "tok1", name: "manual.pdf", size: 12345, mime: "application/pdf" },
      { token: "tok2", name: "song.mp3", size: 67890, mime: "audio/mpeg" },
    ];

    installNativeOpenHook();

    expect(w.__univiewOpen).toHaveBeenCalledTimes(2);
    expect(openedFiles).toHaveLength(2);
    expect(openedFiles[0]!.name).toBe("manual.pdf");
    expect(openedFiles[0]!.size).toBe(12345);
    expect(openedFiles[0]!.mimeHint).toBe("application/pdf");
    expect(openedFiles[1]!.name).toBe("song.mp3");
    expect(openedFiles[1]!.size).toBe(67890);
    expect(openedFiles[1]!.mimeHint).toBe("audio/mpeg");

    expect(w.__univiewPendingShared).toEqual([]);

    w.__univiewOpenShared!("tok3", "image.png", 500, "image/png");
    expect(w.__univiewOpen).toHaveBeenCalledTimes(3);
    expect(openedFiles).toHaveLength(3);
    expect(openedFiles[2]!.name).toBe("image.png");
  });

  it("reports error when __univiewOpen throws during __univiewOpenShared", () => {
    const w = window as unknown as {
      __univiewOpen?: (files: unknown[]) => void;
      __univiewOpenError?: (message: string) => void;
      __univiewOpenShared?: (token: string, name: string, size: number, mime: string) => void;
      __univiewPendingShared?: { token: string; name: string; size: number; mime: string }[];
    };

    w.__univiewOpen = vi.fn(() => {
      throw new Error("Cannot open");
    });
    const errorFn = vi.fn();
    w.__univiewOpenError = errorFn;

    installNativeOpenHook();

    w.__univiewOpenShared!("tokErr", "corrupt.dat", 100, "application/octet-stream");

    expect(errorFn).toHaveBeenCalledWith('Could not open "corrupt.dat".');
  });
});
