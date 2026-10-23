import { readAllChecked, Loading, Spacer, Toolbar, useLoad, useReady } from "./common";
import type { ViewerProps } from "./types";

/** Pull readable runs of UTF-16LE and ASCII text out of a binary compound file. */
export function extractStrings(bytes: Uint8Array, min = 5): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = bytes[i]! | (bytes[i + 1]! << 8);
    if ((c >= 32 && c < 0xd800 && c !== 0xfffd) || c === 9) cur += String.fromCharCode(c);
    else if (c === 13 || c === 10 || c === 11) cur += "\n";
    else {
      if (cur.trim().length >= min) out.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim().length >= min) out.push(cur.trim());
  // Keep runs that look like prose: mostly letters and spaces, not stream names or binary noise.
  return out.filter((s) => /[a-z]{3}/i.test(s) && !/^(Root Entry|WordDocument|PowerPoint Document|SummaryInformation|DocumentSummaryInformation|Current User|Pictures|Data|1Table|0Table|CompObj|ObjectPool)$/.test(s));
}

export default function LegacyOfficeViewer({ source, detection, onReady }: ViewerProps) {
  const text = useLoad(async (signal) => extractStrings(new Uint8Array(await readAllChecked(source, signal, 128 * 1024 * 1024))).join("\n\n"), [source]);
  useReady(text !== undefined, onReady);
  if (text === undefined) return <Loading />;
  return (
    <div className="viewer">
      <Toolbar>
        <span className="muted small">{detection.label}</span>
        <Spacer />
      </Toolbar>
      <div className="banner">
        This is a pre-2007 binary Office file. UniView shows the text it can recover; layout and pictures are not shown.
        For a full view, re-save it as .docx or .pptx.
      </div>
      <div className="scroll">
        <article className="prose plain" data-testid="legacy-text">{text || "No readable text was found in this file."}</article>
      </div>
    </div>
  );
}
