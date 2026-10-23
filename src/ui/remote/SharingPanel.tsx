import { useEffect, useMemo, useState } from "react";
import { renderSVG } from "uqr";
import type { ShareApi, ShareState } from "../../core/types";

/** Host side: what this computer shares, with whom, and who looked at what. */
export function SharingPanel({ share }: { share: ShareApi }) {
  const [state, setState] = useState<ShareState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ path: string; name: string } | null>(null);
  const [syncthing, setSyncthing] = useState<{ label: string; path: string }[] | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let live = true;
    void share.state().then((s) => live && setState(s));
    const off = share.onChanged((s) => setState(s));
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live = false;
      off();
      clearInterval(t);
    };
  }, [share]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      setState(await share.state());
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };

  const chooseFolder = () =>
    run(async () => {
      const path = await share.pickFolder();
      if (path) setConfirm({ path, name: path.split(/[\\/]/).filter(Boolean).pop() ?? path });
    });

  const qr = useMemo(() => (state?.offer ? renderSVG(state.offer.text, { ecc: "M", border: 2, pixelSize: 6, whiteColor: "#ffffff", blackColor: "#111111" }) : ""), [state?.offer]);

  if (!state) return <div className="center-msg">Loading sharing settings…</div>;
  const secondsLeft = state.offer ? Math.max(0, Math.round((state.offer.expiresAt - now) / 1000)) : 0;

  return (
    <div className="scroll sharing" data-testid="sharing-panel">
      <div className="sharing-inner">
        <header className="sharing-head">
          <h1>Share with your devices</h1>
          <p className="muted">
            Browse this computer's chosen folders from your phone or another computer on the same network. Files open on demand; nothing is
            uploaded anywhere, there is no account, and everything is encrypted end to end.
          </p>
        </header>

        {error && <div className="banner warn" role="alert">{error}</div>}

        <section className="card">
          <label className="switch-row">
            <input type="checkbox" checked={state.enabled} onChange={(e) => void run(() => share.setEnabled(e.target.checked))} data-testid="sharing-toggle" />
            <span>
              <strong>Let paired devices browse this computer</strong>
              <span className="muted small block">
                {state.listening ? `On · reachable at ${state.addresses.join(", ") || "this computer"} port ${state.port}` : "Off · nothing is listening"}
              </span>
            </span>
          </label>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Shared folders</h2>
            <div className="row">
              <button onClick={() => void chooseFolder()} data-testid="add-folder">Add folder…</button>
              <button onClick={() => void run(async () => setSyncthing((await share.syncthing()).folders))}>From Syncthing…</button>
            </div>
          </div>
          {state.roots.length === 0 ? (
            <p className="muted small">No folders are shared. Paired devices see nothing until you add one.</p>
          ) : (
            <ul className="plain-list">
              {state.roots.map((r) => (
                <li key={r.id}>
                  <span className="ellipsis"><strong>{r.name}</strong> <span className="muted small">{r.path}</span></span>
                  <button className="link" onClick={() => void run(() => share.removeRoot(r.id))}>Stop sharing</button>
                </li>
              ))}
            </ul>
          )}
          {syncthing && (
            <div className="syncthing">
              {syncthing.length === 0 ? (
                <p className="muted small">No Syncthing folders found on this computer.</p>
              ) : (
                syncthing.map((f) => (
                  <button key={f.path} className="link block" onClick={() => setConfirm({ path: f.path, name: f.label })}>
                    {f.label} <span className="muted small">{f.path}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Paired devices</h2>
            <button className="primary" disabled={!state.listening} onClick={() => void run(() => share.offer())} data-testid="pair-device">Pair a device…</button>
          </div>
          {!state.listening && <p className="muted small">Turn on sharing to pair a device.</p>}
          {state.offer && secondsLeft > 0 && (
            <div className="pair-offer" data-testid="pair-offer">
              <div className="qr" aria-label="Pairing QR code" dangerouslySetInnerHTML={{ __html: qr }} />
              <div className="pair-steps">
                <ol>
                  <li>Open UniView on your phone and tap <strong>Connect a computer</strong>.</li>
                  <li>Scan this code, or paste the code below.</li>
                  <li>Approve the device here when asked.</li>
                </ol>
                <textarea readOnly value={state.offer.text} rows={3} onFocus={(e) => e.target.select()} data-testid="pair-code" aria-label="Pairing code" />
                <div className="row left">
                  <button onClick={() => void navigator.clipboard?.writeText(state.offer!.text)}>Copy code</button>
                  <button onClick={() => void run(() => share.cancelOffer())}>Cancel</button>
                  <span className="muted small">Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")} · works once</span>
                </div>
              </div>
            </div>
          )}
          {state.devices.length === 0 ? (
            <p className="muted small">No devices are paired.</p>
          ) : (
            <ul className="plain-list">
              {state.devices.map((d) => (
                <li key={d.id}>
                  <span>
                    <strong>{d.name}</strong>{" "}
                    <span className="muted small">{d.connected ? "connected" : `last seen ${new Date(d.lastSeen).toLocaleString()}`}</span>
                  </span>
                  <button className="link" onClick={() => void run(() => share.removeDevice(d.id))}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2>Recent activity</h2>
          {state.log.length === 0 ? (
            <p className="muted small">Nothing yet. Every pairing, folder visit and opened file appears here.</p>
          ) : (
            <ul className="plain-list log" data-testid="access-log">
              {state.log.slice(0, 30).map((l, i) => (
                <li key={i}>
                  <span><strong>{l.device}</strong> {l.action} <span className="muted">{l.path}</span></span>
                  <span className="muted small">{new Date(l.at).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {confirm && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="perm-title">
          <div className="modal" data-testid="permission-screen">
            <h2 id="perm-title">Share “{confirm.name}”?</h2>
            <p className="muted small">{confirm.path}</p>
            <ul className="perm-list">
              <li>✓ Paired devices can see the names of files and folders inside it, including subfolders.</li>
              <li>✓ They can open and stream those files over your local network.</li>
              <li>✗ They cannot change, rename, delete or add anything. Sharing is read only.</li>
              <li>✗ Nothing is uploaded to the internet. Hidden files are not shown.</li>
            </ul>
            <p className="muted small">You can stop sharing this folder or remove a device at any time.</p>
            <div className="row right">
              <button onClick={() => setConfirm(null)}>Cancel</button>
              <button
                className="primary"
                data-testid="confirm-share"
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  void run(() => share.addRoot(c.path, c.name));
                }}
              >
                Share read-only
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
