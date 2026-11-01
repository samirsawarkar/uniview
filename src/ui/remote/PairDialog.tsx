import { useEffect, useRef, useState } from "react";
import type { HostRecord } from "../../../shared/remote-client.mjs";
import type { RemoteTransport } from "../../core/types";
import { pair } from "../../remote/connections";
import { deviceName, setDeviceName } from "../../remote/store";
import { decodeQr, isBlackFrame } from "./qr";

/** Connect to a computer: scan its QR code with the camera, or paste the pairing code. */
export function PairDialog({ transport, canScan, onClose, onPaired }: {
  transport: RemoteTransport;
  canScan: boolean;
  onClose: () => void;
  onPaired: (h: HostRecord) => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState(deviceName());
  const [scanning, setScanning] = useState(canScan);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (text: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDeviceName(name || deviceName());
    try {
      onPaired(await pair(text, transport));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="pair-title">
      <div className="modal" data-testid="pair-dialog">
        <h2 id="pair-title">Connect a computer</h2>
        <p className="muted small">
          On the computer, open UniView, click <strong>Share with phone</strong>, turn sharing on and click <strong>Pair a device</strong>.
        </p>
        {scanning && !busy && <QrScanner onCode={(t) => { setScanning(false); setCode(t); void submit(t); }} onUnavailable={() => setScanning(false)} />}
        <label className="field">
          <span className="small muted">Pairing code</span>
          <textarea value={code} onChange={(e) => setCode(e.target.value)} rows={3} placeholder="uniview:pair?…" data-testid="pair-code-input" spellCheck={false} />
        </label>
        <label className="field">
          <span className="small muted">This device's name (shown on the computer)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        </label>
        {busy && <p className="small">Waiting for the computer's owner to approve this device…</p>}
        {error && <div className="banner warn" role="alert">{error}</div>}
        <div className="row right">
          {canScan && !scanning && <button onClick={() => setScanning(true)}>Scan QR code</button>}
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!code.trim() || busy} onClick={() => void submit(code)} data-testid="pair-connect">Connect</button>
        </div>
      </div>
    </div>
  );
}

/** Camera QR scanner: the browser's BarcodeDetector when available, jsQR otherwise. Frames never leave the device. */
function QrScanner({ onCode, onUnavailable }: { onCode: (text: string) => void; onUnavailable: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [msg, setMsg] = useState("Starting camera…");

  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [black, setBlack] = useState(false);

  useEffect(() => {
    setBlack(false);
    let stream: MediaStream | null = null;
    let stopped = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let blackSince = 0;
    const Detector = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    const detector = Detector ? new Detector({ formats: ["qr_code"] }) : null;

    const tick = async () => {
      if (stopped) return;
      const v = video.current;
      if (v && v.readyState >= 2) {
        try {
          let text: string | null = null;
          if (ctx && v.videoWidth > 0) {
            const w = (canvas.width = Math.min(720, v.videoWidth));
            const h = (canvas.height = Math.round((v.videoHeight * w) / v.videoWidth));
            ctx.drawImage(v, 0, 0, w, h);
            const pixels = ctx.getImageData(0, 0, w, h).data;
            // A black picture for a few seconds usually means the lens is covered (phone lying on a table).
            if (isBlackFrame(pixels)) {
              blackSince ||= Date.now();
              if (Date.now() - blackSince > 2500) setBlack(true);
            } else {
              blackSince = 0;
              setBlack(false);
            }
            if (!detector) text = decodeQr(pixels, w, h);
          }
          if (detector) text = (await detector.detect(v))[0]?.rawValue ?? null;
          if (text?.startsWith("uniview:pair?")) {
            stopped = true;
            onCode(text);
            return;
          }
        } catch {
          /* keep scanning */
        }
      }
      setTimeout(() => void tick(), 150);
    };

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: facing }, audio: false })
      .then((s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play().catch(() => undefined);
        }
        setMsg("Point the camera at the code on the computer's screen.");
        void tick();
      })
      .catch(() => {
        setMsg("");
        onUnavailable();
      });
    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode, onUnavailable, facing]);

  return (
    <div className="qr-scan">
      <video ref={video} muted playsInline autoPlay aria-label="Camera" />
      <span className="small muted">{black ? "The camera picture is black. Uncover the lens, or switch to the other camera." : msg}</span>
      <button type="button" onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}>Switch camera</button>
    </div>
  );
}
