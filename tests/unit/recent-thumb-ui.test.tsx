import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RecentThumb } from "../../src/ui/recent-thumbs";
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
});
