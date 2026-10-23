import { useEffect, useRef, useState } from "react";
import * as UTIF from "utif2";
import { CorruptFileError } from "../core/errors";
import { Loading, readAllChecked, useLoad } from "./common";
import { ZoomStage } from "./ImageViewer";
import type { ViewerProps } from "./types";

interface Decoded {
  pages: { width: number; height: number; rgba: Uint8Array }[];
}

export default function TiffViewer({ source, onReady }: ViewerProps) {
  const decoded = useLoad<Decoded>(async (signal) => {
    const buf = await readAllChecked(source, signal, 256 * 1024 * 1024);
    try {
      const ifds = UTIF.decode(buf);
      const pages = ifds.slice(0, 50).map((ifd) => {
        UTIF.decodeImage(buf, ifd);
        return { width: ifd.width, height: ifd.height, rgba: UTIF.toRGBA8(ifd) };
      }).filter((p) => p.width > 0 && p.height > 0);
      if (!pages.length) throw new Error("no image pages");
      return { pages };
    } catch (err) {
      throw new CorruptFileError(`This TIFF could not be decoded: ${(err as Error).message}`);
    }
  }, [source]);
  const [index, setIndex] = useState(0);
  if (!decoded) return <Loading />;
  const page = decoded.pages[Math.min(index, decoded.pages.length - 1)]!;
  return (
    <div className="viewer column">
      {decoded.pages.length > 1 && (
        <div className="page-strip">
          {decoded.pages.map((_, i) => (
            <button key={i} className={i === index ? "active" : ""} onClick={() => setIndex(i)}>Page {i + 1}</button>
          ))}
        </div>
      )}
      <ZoomStage label="TIFF image" natural={{ w: page.width, h: page.height }} onReady={onReady} render={(style) => <TiffCanvas page={page} style={style} />} />
    </div>
  );
}

function TiffCanvas({ page, style }: { page: Decoded["pages"][number]; style: React.CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = page.width;
    c.height = page.height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(page.rgba), page.width, page.height), 0, 0);
  }, [page]);
  return <canvas ref={ref} style={style} />;
}
