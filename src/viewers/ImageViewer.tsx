import { useEffect, useRef, useState } from "react";
import { CorruptFileError } from "../core/errors";
import { Loading, Spacer, Toolbar, useLoad, useReady } from "./common";
import type { ViewerProps } from "./types";

export default function ImageViewer({ source, detection, onReady }: ViewerProps) {
  const url = useLoad(() => source.url(), [source]);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (error) throw new CorruptFileError(error);
  if (!url) return <Loading />;
  return (
    <ZoomStage
      label={detection.label}
      natural={natural}
      onReady={onReady}
      render={(style) => (
        <img
          src={url}
          alt={source.name}
          style={style}
          draggable={false}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 300, h: e.currentTarget.naturalHeight || 150 })}
          onError={() => setError("This image could not be decoded. It may be damaged or use an unsupported encoding.")}
        />
      )}
    />
  );
}

/** Fit, zoom, pan and rotate any image-like content. */
export function ZoomStage({ label, natural, onReady, render }: {
  label: string;
  natural: { w: number; h: number } | null;
  onReady: () => void;
  render: (style: React.CSSProperties) => React.ReactNode;
}) {
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [rotation, setRotation] = useState(0);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const stage = useRef<HTMLDivElement>(null);
  useReady(!!natural, onReady);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rotated = rotation % 180 !== 0;
  const nw = natural ? (rotated ? natural.h : natural.w) : 0;
  const nh = natural ? (rotated ? natural.w : natural.h) : 0;
  const fit = natural && box.w ? Math.min(1, (box.w - 24) / nw, (box.h - 24) / nh) : 1;
  const scale = zoom === "fit" ? fit : zoom;

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(Math.min(16, Math.max(0.05, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
  };

  const w = natural ? natural.w * scale : undefined;
  const h = natural ? natural.h * scale : undefined;
  return (
    <div className="viewer image-viewer">
      <Toolbar>
        <button onClick={() => setZoom(Math.max(0.05, scale / 1.25))} aria-label="Zoom out">−</button>
        <button onClick={() => setZoom("fit")} className={zoom === "fit" ? "active" : ""} title="Fit to window">{Math.round(scale * 100)}%</button>
        <button onClick={() => setZoom(Math.min(16, scale * 1.25))} aria-label="Zoom in">+</button>
        <button onClick={() => setZoom(1)} title="Actual size">1:1</button>
        <button onClick={() => setRotation((r) => (r + 90) % 360)} aria-label="Rotate" title="Rotate 90°">⟳</button>
        <Spacer />
        <span className="muted small">{label}{natural ? ` · ${natural.w} × ${natural.h}` : ""}</span>
      </Toolbar>
      <div className="scroll stage checker" ref={stage} onWheel={onWheel}>
        <div className="stage-inner" style={{ width: rotated ? h : w, height: rotated ? w : h }}>
          {render({ width: w, height: h, transform: `rotate(${rotation}deg)`, maxWidth: "none" })}
        </div>
      </div>
    </div>
  );
}
