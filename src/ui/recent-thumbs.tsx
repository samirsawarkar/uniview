// Thumbnails for the home page's recent files: from the OS thumbnailer, the remote thumbnail cache,
// or a local image decoded in the page. Never fetched over the network.
import { useEffect, useState } from "react";
import type { FileSource, FormatKind, ShellBridge } from "../core/types";
import { detect } from "../core/detect";
import { cachedThumb, storeThumb } from "../remote/store";
import { KindBadge } from "./badges";
import type { Recent } from "./recents";

export function recentThumbKey(
  r: Pick<Recent, "name" | "path" | "size" | "remote">,
): string | null {
  if (r.remote) {
    return `${r.remote.hostId}|${r.remote.rootId}|${r.remote.path}|${r.remote.mtime}`;
  }
  if (r.path) {
    return `local|${r.path}|${r.size}`;
  }
  if (r.name) {
    return `local-name|${r.name}|${r.size}`;
  }
  return null;
}

export async function captureRecentThumb(
  bridge: Pick<ShellBridge, "thumbnail">,
  source: FileSource,
  detectionKind: FormatKind | undefined,
): Promise<void> {
  try {
    if (source.remote) return;
    const key = recentThumbKey(source);
    if (!key) return;

    if (typeof bridge?.thumbnail === "function") {
      const blob = await bridge.thumbnail(source, 192);
      if (blob) {
        await storeThumb(key, blob);
      }
      return;
    }

    if (detectionKind !== "image") return;
    if (source.size > 20 * 1024 * 1024) return;
    if (typeof createImageBitmap !== "function") return;
    if (typeof document === "undefined" || typeof document.createElement !== "function") return;

    const bytes = await source.readAll();
    const blob = new Blob([bytes]);
    const bmp = await createImageBitmap(blob);
    try {
      const maxSide = 192;
      const maxDim = Math.max(bmp.width, bmp.height);
      if (maxDim <= 0) return;
      const scale = maxDim > maxSide ? maxSide / maxDim : 1;
      const width = Math.max(1, Math.round(bmp.width * scale));
      const height = Math.max(1, Math.round(bmp.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext?.("2d");
      if (!ctx || typeof canvas.toBlob !== "function") return;

      ctx.drawImage(bmp, 0, 0, width, height);

      const thumbBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));

      if (thumbBlob) {
        await storeThumb(key, thumbBlob);
      }
    } finally {
      bmp.close?.();
    }
  } catch {
    /* errors are swallowed */
  }
}

export async function loadRecentThumb(
  r: Pick<Recent, "name" | "path" | "size" | "remote">,
): Promise<Blob | undefined> {
  const key = recentThumbKey(r);
  if (!key) return undefined;
  return cachedThumb(key);
}

export function RecentThumb({ recent }: { recent: Pick<Recent, "name" | "path" | "size" | "remote"> }) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let url: string | null = null;
    setThumbUrl(null);

    void loadRecentThumb(recent)
      .then((blob) => {
        if (!active) return;
        if (blob) {
          url = URL.createObjectURL(blob);
          setThumbUrl(url);
        } else {
          setThumbUrl(null);
        }
      })
      .catch(() => {
        if (active) setThumbUrl(null);
      });

    return () => {
      active = false;
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [recentThumbKey(recent)]);

  if (thumbUrl) {
    return <img className="recent-thumb" src={thumbUrl} alt="" />;
  }

  const kind = detect(recent.name, new Uint8Array(0)).kind;
  return <KindBadge kind={kind} />;
}
