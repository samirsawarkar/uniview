import { useState } from "react";
import { Loading, useLoad, useReady } from "./common";
import type { ViewerProps } from "./types";

export function mediaErrorText(code: number): { message: string; decoderNote: boolean } {
  if (code === 1) {
    return { message: "Playback was stopped.", decoderNote: false };
  }
  if (code === 2) {
    return {
      message: "Reading the file failed. If it is on another computer, it may no longer be shared or the computer may be off.",
      decoderNote: false,
    };
  }
  if (code === 3) {
    return {
      message: "This file is damaged or uses an encoding this device cannot decode.",
      decoderNote: true,
    };
  }
  return {
    message: "This device has no decoder for this format or codec.",
    decoderNote: code === 4,
  };
}

export default function MediaViewer({ source, detection, onReady }: ViewerProps) {
  const url = useLoad(() => source.url(), [source]);
  const [ready, setReady] = useState(false);
  const [errorInfo, setErrorInfo] = useState<{ message: string; decoderNote: boolean } | null>(null);
  useReady(ready || !!errorInfo, onReady);
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
      setErrorInfo(mediaErrorText(code));
    },
  };
  return (
    <div className={`viewer media-viewer ${isVideo ? "is-video" : "is-audio"}`}>
      {errorInfo ? (
        <div className="center-msg" role="alert">
          <strong>Cannot play “{source.name}”</strong>
          <span>{errorInfo.message}</span>
          {errorInfo.decoderNote && (
            <span className="muted small">{detection.label}. UniView uses this device's own media decoders and bundles none, so playback depends on the formats this system supports.</span>
          )}
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
