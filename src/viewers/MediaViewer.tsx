import { useState } from "react";
import { Loading, useLoad, useReady } from "./common";
import type { ViewerProps } from "./types";

const MEDIA_ERRORS: Record<number, string> = {
  1: "Playback was stopped.",
  2: "A read error interrupted playback.",
  3: "This file is damaged or uses an encoding this device cannot decode.",
  4: "This device has no decoder for this format or codec.",
};

export default function MediaViewer({ source, detection, onReady }: ViewerProps) {
  const url = useLoad(() => source.url(), [source]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useReady(ready || !!error, onReady);
  if (!url) return <Loading />;
  const isVideo = detection.kind === "video";
  const common = {
    src: url,
    controls: true,
    autoPlay: false,
    preload: "metadata" as const,
    onLoadedMetadata: () => setReady(true),
    onError: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const code = e.currentTarget.error?.code ?? 4;
      setError(MEDIA_ERRORS[code] ?? MEDIA_ERRORS[4]!);
    },
  };
  return (
    <div className={`viewer media-viewer ${isVideo ? "is-video" : "is-audio"}`}>
      {error ? (
        <div className="center-msg" role="alert">
          <strong>Cannot play “{source.name}”</strong>
          <span>{error}</span>
          <span className="muted small">{detection.label}. UniView uses this device's own media decoders and bundles none, so playback depends on the formats this system supports.</span>
        </div>
      ) : isVideo ? (
        <video {...common} playsInline data-testid="video" />
      ) : (
        <div className="audio-card">
          <div className="audio-art" aria-hidden>♪</div>
          <div className="audio-title">{source.name}</div>
          <audio {...common} data-testid="audio" />
        </div>
      )}
    </div>
  );
}
