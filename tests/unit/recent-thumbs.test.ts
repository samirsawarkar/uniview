import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileSource } from "../../src/core/types";
import { recentThumbKey, captureRecentThumb } from "../../src/ui/recent-thumbs";
import { storeThumb } from "../../src/remote/store";

vi.mock("../../src/remote/store", () => ({
  storeThumb: vi.fn().mockResolvedValue(undefined),
  cachedThumb: vi.fn().mockResolvedValue(undefined),
}));

describe("recentThumbKey", () => {
  // Mutation: remote recents key format deviates from hostId|rootId|path|mtime
  it("generates correct key for remote recents", () => {
    const r = {
      name: "photo.jpg",
      size: 1024,
      remote: {
        hostId: "host-1",
        rootId: "root-1",
        rootName: "Media",
        path: "/photos/photo.jpg",
        mtime: 1700000000,
      },
    };
    expect(recentThumbKey(r)).toBe("host-1|root-1|/photos/photo.jpg|1700000000");
  });

  // Mutation: local recents with a path not formatted as local|path|size
  it("generates correct key for local recents with path", () => {
    const r = {
      name: "notes.txt",
      path: "/home/user/notes.txt",
      size: 2048,
    };
    expect(recentThumbKey(r)).toBe("local|/home/user/notes.txt|2048");
  });

  // Mutation: local recents without path not formatted as local-name|name|size
  it("generates correct key for local recents without path", () => {
    const r = {
      name: "upload.png",
      size: 4096,
    };
    expect(recentThumbKey(r)).toBe("local-name|upload.png|4096");
  });
});

describe("captureRecentThumb", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Mutation: captureRecentThumb does not call bridge.thumbnail or store the returned blob
  it("stores thumbnail from bridge when available", async () => {
    const mockBlob = new Blob(["thumb-data"], { type: "image/png" });
    const bridge = {
      thumbnail: vi.fn().mockResolvedValue(mockBlob),
    };
    const source: FileSource = {
      id: "f1",
      name: "photo.jpg",
      path: "/docs/photo.jpg",
      size: 5000,
      readAll: vi.fn(),
      readRange: vi.fn(),
      url: vi.fn(),
      release: vi.fn(),
    };

    await captureRecentThumb(bridge, source, "image");

    expect(bridge.thumbnail).toHaveBeenCalledWith(source, 192);
    expect(storeThumb).toHaveBeenCalledWith("local|/docs/photo.jpg|5000", mockBlob);
  });

  // Mutation: captureRecentThumb does not decode in-page with createImageBitmap and canvas when bridge is absent
  it("decodes in-page image with createImageBitmap and stores PNG when bridge.thumbnail is absent", async () => {
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;

    const mockClose = vi.fn();
    const mockBmp = { width: 384, height: 192, close: mockClose };
    globalThis.createImageBitmap = vi.fn().mockResolvedValue(mockBmp);

    const mockCtx = { drawImage: vi.fn() };
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx);

    const generatedBlob = new Blob(["png-bytes"], { type: "image/png" });
    HTMLCanvasElement.prototype.toBlob = vi.fn().mockImplementation((cb: (b: Blob | null) => void) => {
      cb(generatedBlob);
    });

    const source: FileSource = {
      id: "f2",
      name: "graphic.png",
      path: "/images/graphic.png",
      size: 1024,
      readAll: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
      readRange: vi.fn(),
      url: vi.fn(),
      release: vi.fn(),
    };

    try {
      await captureRecentThumb({}, source, "image");

      expect(globalThis.createImageBitmap).toHaveBeenCalled();
      expect(mockCtx.drawImage).toHaveBeenCalledWith(mockBmp, 0, 0, 192, 96);
      expect(mockClose).toHaveBeenCalled();
      expect(storeThumb).toHaveBeenCalledWith("local|/images/graphic.png|1024", generatedBlob);
    } finally {
      globalThis.createImageBitmap = originalCreateImageBitmap;
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
    }
  });

  // Mutation: non-image kinds without bridge thumbnailer mistakenly attempt decoding or storage
  it("stores nothing for non-image files when bridge has no thumbnailer", async () => {
    const source: FileSource = {
      id: "f3",
      name: "document.pdf",
      path: "/docs/document.pdf",
      size: 1024,
      readAll: vi.fn(),
      readRange: vi.fn(),
      url: vi.fn(),
      release: vi.fn(),
    };

    // createImageBitmap must exist, or the early "no decoder" return would hide the kind check.
    vi.stubGlobal("createImageBitmap", vi.fn());
    try {
      await captureRecentThumb({}, source, "pdf");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(source.readAll).not.toHaveBeenCalled();
    expect(storeThumb).not.toHaveBeenCalled();
  });

  // Mutation: errors in thumbnailer bubble up instead of being swallowed
  it("does not throw when bridge.thumbnail rejects", async () => {
    const bridge = {
      thumbnail: vi.fn().mockRejectedValue(new Error("os thumbnail failed")),
    };
    const source: FileSource = {
      id: "f4",
      name: "corrupt.jpg",
      path: "/docs/corrupt.jpg",
      size: 1024,
      readAll: vi.fn(),
      readRange: vi.fn(),
      url: vi.fn(),
      release: vi.fn(),
    };

    await expect(captureRecentThumb(bridge, source, "image")).resolves.toBeUndefined();
    expect(storeThumb).not.toHaveBeenCalled();
  });

  // Mutation: images larger than 20 MB read all bytes instead of skipping immediately
  it("skips images over 20 MB without calling readAll", async () => {
    const readAll = vi.fn();
    const source: FileSource = {
      id: "f5",
      name: "giant.png",
      path: "/photos/giant.png",
      size: 20 * 1024 * 1024 + 1,
      readAll,
      readRange: vi.fn(),
      url: vi.fn(),
      release: vi.fn(),
    };

    vi.stubGlobal("createImageBitmap", vi.fn());
    try {
      await captureRecentThumb({}, source, "image");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(readAll).not.toHaveBeenCalled();
    expect(storeThumb).not.toHaveBeenCalled();
  });
});
