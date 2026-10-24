import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { FileSource } from "../../src/core/types";
import { RecentThumb, captureRecentThumb } from "../../src/ui/recent-thumbs";
import * as store from "../../src/remote/store";

vi.mock("../../src/remote/store", () => ({
  cachedThumb: vi.fn(),
  storeThumb: vi.fn(),
}));

describe("RecentThumb component", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    if (container) {
      container.remove();
    }
    container = null;
    root = null;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.clearAllMocks();
  });

  // Mutation: recent-thumb component does not show an <img> with object URL when loadRecentThumb resolves a blob
  it("shows an img when loadRecentThumb resolves a blob", async () => {
    const mockBlob = new Blob(["thumb-data"], { type: "image/png" });
    vi.mocked(store.cachedThumb).mockResolvedValue(mockBlob);
    URL.createObjectURL = vi.fn().mockReturnValue("blob:uniview-thumb-123");
    URL.revokeObjectURL = vi.fn();

    const recent = {
      name: "sample.png",
      path: "/images/sample.png",
      size: 1024,
    };

    await act(async () => {
      root!.render(<RecentThumb recent={recent} />);
    });

    const img = container!.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("blob:uniview-thumb-123");
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.className).toBe("recent-thumb");
  });

  // Mutation: recent-thumb component does not fallback to KindBadge when loadRecentThumb resolves undefined
  it("shows the kind badge when loadRecentThumb resolves undefined", async () => {
    vi.mocked(store.cachedThumb).mockResolvedValue(undefined);
    URL.createObjectURL = vi.fn();

    const recent = {
      name: "report.pdf",
      path: "/docs/report.pdf",
      size: 2048,
    };

    await act(async () => {
      root!.render(<RecentThumb recent={recent} />);
    });

    const img = container!.querySelector("img");
    expect(img).toBeNull();
    const badge = container!.querySelector(".kind-badge") ?? container!.querySelector(".badge");
    expect(badge).not.toBeNull();
  });

  // Mutation: recent-thumb component fails to revoke object URL on unmount
  it("revokes the object URL on unmount", async () => {
    const mockBlob = new Blob(["thumb-data"], { type: "image/png" });
    vi.mocked(store.cachedThumb).mockResolvedValue(mockBlob);
    URL.createObjectURL = vi.fn().mockReturnValue("blob:uniview-thumb-456");
    const revokeMock = vi.fn();
    URL.revokeObjectURL = revokeMock;

    const recent = {
      name: "art.png",
      path: "/images/art.png",
      size: 5000,
    };

    await act(async () => {
      root!.render(<RecentThumb recent={recent} />);
    });

    expect(revokeMock).not.toHaveBeenCalled();

    act(() => {
      root!.unmount();
    });
    root = null;

    expect(revokeMock).toHaveBeenCalledWith("blob:uniview-thumb-456");
  });

  // Mutation: RecentThumb does not use remote key format hostId|rootId|path|mtime for cache lookup
  it("shows thumbnail cached under the remote key for a remote recent", async () => {
    const mockBlob = new Blob(["remote-thumb"], { type: "image/png" });
    const remoteKey = "host-42|root-99|/photos/vacation.jpg|1710000000";
    vi.mocked(store.cachedThumb).mockImplementation(async (key: string) => {
      if (key === remoteKey) return mockBlob;
      return undefined;
    });
    URL.createObjectURL = vi.fn().mockReturnValue("blob:remote-thumb-url");

    const recent = {
      name: "vacation.jpg",
      size: 2048,
      remote: {
        hostId: "host-42",
        rootId: "root-99",
        rootName: "Photos",
        path: "/photos/vacation.jpg",
        mtime: 1710000000,
      },
    };

    await act(async () => {
      root!.render(<RecentThumb recent={recent} />);
    });

    expect(store.cachedThumb).toHaveBeenCalledWith(remoteKey);
    const img = container!.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("blob:remote-thumb-url");
  });

  // Mutation: RecentThumb fails to subscribe to onThumbStored and re-read the cache when its key is stored, or reads cache more than twice
  it("first misses, then after captureRecentThumb stores its key shows the img with exactly two cache reads", async () => {
    const key = "local|/docs/capture.png|1024";
    let storedBlob: Blob | undefined = undefined;

    vi.mocked(store.cachedThumb).mockImplementation(async (k: string) => {
      if (k === key) return storedBlob;
      return undefined;
    });

    vi.mocked(store.storeThumb).mockImplementation(async (k: string, b: Blob) => {
      if (k === key) {
        storedBlob = b;
      }
    });

    URL.createObjectURL = vi.fn().mockReturnValue("blob:captured-thumb-789");

    const recent = {
      name: "capture.png",
      path: "/docs/capture.png",
      size: 1024,
    };

    await act(async () => {
      root!.render(<RecentThumb recent={recent} />);
    });

    expect(container!.querySelector("img")).toBeNull();
    expect(store.cachedThumb).toHaveBeenCalledTimes(1);
    expect(store.cachedThumb).toHaveBeenCalledWith(key);

    const thumbData = new Blob(["png-data"], { type: "image/png" });
    const bridge = {
      thumbnail: vi.fn().mockResolvedValue(thumbData),
    };
    const source: FileSource = {
      id: "f-cap",
      name: "capture.png",
      path: "/docs/capture.png",
      size: 1024,
      readAll: vi.fn(),
      readRange: vi.fn(),
      url: vi.fn(),
      release: vi.fn(),
    };

    await act(async () => {
      await captureRecentThumb(bridge, source, "image");
    });

    expect(store.cachedThumb).toHaveBeenCalledTimes(2);
    const img = container!.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("blob:captured-thumb-789");
  });
});
