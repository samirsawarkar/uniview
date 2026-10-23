import { useEffect, useState } from "react";
import { CorruptFileError } from "../core/errors";
import { Loading, Spacer, Toolbar, readAllChecked, useLoad, useReady } from "./common";
import type { ViewerProps } from "./types";

const SAMPLE = "The quick brown fox jumps over the lazy dog";
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!?&@#%$€£¥()[]{}";

export default function FontViewer({ source, onReady }: ViewerProps) {
  const family = useLoad(async (signal) => {
    const buf = await readAllChecked(source, signal, 64 * 1024 * 1024);
    const name = `uv-font-${source.id}`;
    try {
      const face = new FontFace(name, buf);
      await face.load();
      document.fonts.add(face);
      return { name, face };
    } catch (err) {
      throw new CorruptFileError(`This font could not be loaded: ${(err as Error).message}`);
    }
  }, [source]);
  const [text, setText] = useState(SAMPLE);
  useEffect(() => () => void (family && document.fonts.delete(family.face)), [family]);
  useReady(!!family, onReady);
  if (!family) return <Loading />;
  const ff = { fontFamily: `"${family.name}", sans-serif` };
  return (
    <div className="viewer">
      <Toolbar>
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} aria-label="Sample text" />
        <Spacer />
      </Toolbar>
      <div className="scroll font-sheet" data-testid="font-sheet">
        {[72, 48, 32, 24, 16, 12].map((s) => (
          <div key={s} className="font-row"><span className="muted small">{s}px</span><div style={{ ...ff, fontSize: s }}>{text || SAMPLE}</div></div>
        ))}
        <div className="glyph-grid" style={ff}>{[...GLYPHS].map((g) => <span key={g}>{g}</span>)}</div>
      </div>
    </div>
  );
}
