import { useEffect, useMemo, useRef, useState } from "react";
import * as UTIF from "utif2";
import { CorruptFileError } from "../core/errors";
import { Loading, readAllChecked, useLoad } from "./common";
import { ZoomStage } from "./ImageViewer";
import type { ViewerProps } from "./types";

/** Largest page UniView decodes: 64 megapixels is 256 MB of RGBA. */
export const MAX_TIFF_PIXELS = 64 * 1024 * 1024;
const MAX_PAGES = 200;

interface Page {
  width: number;
  height: number;
  ifd: UTIF.IFD;
}

/** Page dimensions from the TIFF tags, read before anything is decoded or allocated. */
export function tiffPages(buf: ArrayBuffer): Page[] {
  let ifds: UTIF.IFD[];
  try {
    ifds = UTIF.decode(buf);
  } catch (err) {
    throw new CorruptFileError(`This TIFF could not be read: ${(err as Error).message}`);
  }
  const pages: Page[] = [];
  for (const ifd of ifds.slice(0, MAX_PAGES)) {
    const tag = (n: string) => (ifd[n] as number[] | undefined)?.[0] ?? 0;
    const width = tag("t256");
    const height = tag("t257");
    if (width > 0 && height > 0) pages.push({ width, height, ifd });
  }
  if (!pages.length) throw new CorruptFileError("This TIFF has no image pages.");
  return pages;
}

/** Decode one page, refusing sizes that would exhaust memory. */
export function decodeTiffPage(buf: ArrayBuffer, page: Page): Uint8Array {
  if (page.width * page.height > MAX_TIFF_PIXELS) {
    throw new CorruptFileError(`This TIFF page is ${page.width} × ${page.height} pixels, larger than the 64-megapixel limit UniView decodes.`);
  }
  try {
    UTIF.decodeImage(buf, page.ifd);
    return UTIF.toRGBA8(page.ifd);
  } catch (err) {
    throw new CorruptFileError(`This TIFF page could not be decoded: ${(err as Error).message}`);
  }
}

export default function TiffViewer({ source, onReady }: ViewerProps) {
  const data = useLoad(async (signal) => {
    const buf = await readAllChecked(source, signal, 256 * 1024 * 1024);
    return { buf, pages: tiffPages(buf) };
  }, [source]);
  const [index, setIndex] = useState(0);
  // Only the visible page is decoded; switching pages releases the previous one.
  const rgba = useMemo(() => (data ? decodeTiffPage(data.buf, data.pages[Math.min(index, data.pages.length - 1)]!) : null), [data, index]);
  if (!data || !rgba) return <Loading />;
  const page = data.pages[Math.min(index, data.pages.length - 1)]!;
  return (
    <div className="viewer column">
      {data.pages.length > 1 && (
        <div className="page-strip">
          {data.pages.map((_, i) => (
            <button key={i} className={i === index ? "active" : ""} onClick={() => setIndex(i)}>Page {i + 1}</button>
          ))}
        </div>
      )}
      <ZoomStage label="TIFF image" natural={{ w: page.width, h: page.height }} onReady={onReady} render={(style) => <TiffCanvas width={page.width} height={page.height} rgba={rgba} style={style} />} />
    </div>
  );
}

function TiffCanvas({ width, height, rgba, style }: { width: number; height: number; rgba: Uint8Array; style: React.CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = width;
    c.height = height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  }, [width, height, rgba]);
  return <canvas ref={ref} style={style} />;
}
