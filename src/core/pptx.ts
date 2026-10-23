import { CorruptFileError } from "./errors";
import { attr, descendants, kid, kids, numAttr, parseXml, path } from "./xml";
import { ZipPackage, resolvePath } from "./zip";

/** EMU per point (OOXML lengths are English Metric Units). */
export const EMU_PER_PT = 12700;

export interface Fill {
  color?: string; // CSS color
  imagePart?: string; // zip part for picture fills
  gradient?: { angle: number; stops: { pos: number; color: string }[] };
}

export interface Line {
  color: string;
  widthPt: number;
  dash?: string;
}

export interface Run {
  text: string;
  sizePt?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  font?: string;
  baseline?: number; // percent, superscript > 0
  isBreak?: boolean;
}

export interface Paragraph {
  align: "left" | "center" | "right" | "justify";
  level: number;
  bullet?: string;
  indentPt: number;
  spaceBeforePt: number;
  spaceAfterPt: number;
  lineSpacing?: number; // multiple of single
  runs: Run[];
  /** Size used for empty paragraphs so blank lines keep their height. */
  endSizePt?: number;
}

export interface TextBody {
  paragraphs: Paragraph[];
  anchor: "top" | "middle" | "bottom";
  insetsPt: [number, number, number, number]; // left, top, right, bottom
  wrap: boolean;
  vertical: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number; // points
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

export interface ShapeEl extends Box {
  type: "shape";
  geom: string;
  fill?: Fill;
  line?: Line;
  text?: TextBody;
  adj?: number;
}

export interface ImageEl extends Box {
  type: "image";
  part: string;
  crop?: { l: number; t: number; r: number; b: number }; // fractions
}

export interface TableCell {
  text: TextBody;
  fill?: Fill;
  gridSpan: number;
  rowSpan: number;
  merged: boolean;
  borders?: Partial<Record<"l" | "r" | "t" | "b", Line>>;
}

export interface TableEl extends Box {
  type: "table";
  colWidths: number[];
  rows: { h: number; cells: TableCell[] }[];
}

export interface PlaceholderEl extends Box {
  type: "placeholder";
  label: string; // chart, diagram, media...
}

export type SlideElement = ShapeEl | ImageEl | TableEl | PlaceholderEl;

export interface Slide {
  index: number;
  background?: Fill;
  elements: SlideElement[];
  notes?: string;
  hidden: boolean;
}

export interface Presentation {
  widthPt: number;
  heightPt: number;
  slides: Slide[];
  thumbnailPart?: string;
  /** Parts referenced as images, to turn into blob URLs. */
  pkg: ZipPackage;
  warnings: string[];
}

// ---------------------------------------------------------------- theme and colors

interface Theme {
  colors: Record<string, string>; // dk1, lt1, accent1... as hex without #
  majorFont?: string;
  minorFont?: string;
  fillStyles: Element[];
  lineStyles: Element[];
  bgFillStyles: Element[];
}

const PRESET_COLORS: Record<string, string> = {
  black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00",
  gray: "808080", grey: "808080", darkGray: "A9A9A9", lightGray: "D3D3D3", orange: "FFA500",
  purple: "800080", navy: "000080", teal: "008080", silver: "C0C0C0", maroon: "800000",
};

const SYSTEM_DEFAULTS: Record<string, string> = { windowText: "000000", window: "FFFFFF" };

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Parse "#RRGGBB", "RRGGBB" or an "rgba(r, g, b, a)" produced by an earlier alpha modifier. */
function parseColor(input: string): [number, number, number, number] {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(input.trim());
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1];
  const h = input.replace(/^#/, "").padStart(6, "0").slice(-6);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/** Apply DrawingML color transforms (lumMod, lumOff, tint, shade, alpha...) to a hex color. */
export function applyColorMods(color: string, mods: Element[]): string {
  let [r, g, b, alpha] = parseColor(color);
  for (const m of mods) {
    const v = (numAttr(m, "val") ?? 100000) / 100000;
    switch (m.localName) {
      case "lumMod": {
        const [h, s, l] = rgbToHsl(r, g, b);
        [r, g, b] = hslToRgb(h, s, clamp01(l * v));
        break;
      }
      case "lumOff": {
        const [h, s, l] = rgbToHsl(r, g, b);
        [r, g, b] = hslToRgb(h, s, clamp01(l + v));
        break;
      }
      case "satMod": {
        const [h, s, l] = rgbToHsl(r, g, b);
        [r, g, b] = hslToRgb(h, clamp01(s * v), l);
        break;
      }
      case "tint":
        r = r + (255 - r) * (1 - v); g = g + (255 - g) * (1 - v); b = b + (255 - b) * (1 - v);
        break;
      case "shade":
        r *= v; g *= v; b *= v;
        break;
      case "alpha":
        alpha = v;
        break;
      case "alphaMod":
        alpha *= v;
        break;
    }
  }
  const to = (n: number) => Math.round(Math.min(255, Math.max(0, n)));
  if (alpha < 1) return `rgba(${to(r)}, ${to(g)}, ${to(b)}, ${Math.round(alpha * 1000) / 1000})`;
  return "#" + [r, g, b].map((n) => to(n).toString(16).padStart(2, "0")).join("").toUpperCase();
}

interface Ctx {
  theme: Theme;
  clrMap: Record<string, string>;
  /** Color substituted for schemeClr phClr inside style matrix entries. */
  phClr?: string;
}

/** Resolve the first color child of el (srgbClr, schemeClr, sysClr, prstClr, scrgbClr, hslClr). */
export function readColor(el: Element | undefined, ctx: Ctx): string | undefined {
  if (!el) return undefined;
  for (const c of Array.from(el.children)) {
    let base: string | undefined;
    switch (c.localName) {
      case "srgbClr":
        base = attr(c, "val");
        break;
      case "schemeClr": {
        const name = attr(c, "val") ?? "";
        if (name === "phClr") {
          if (!ctx.phClr) return undefined;
          return c.children.length ? applyColorMods(ctx.phClr, Array.from(c.children)) : ctx.phClr;
        }
        const mapped = ctx.clrMap[name] ?? name;
        base = ctx.theme.colors[mapped] ?? ctx.theme.colors[name];
        break;
      }
      case "sysClr":
        base = attr(c, "lastClr") ?? SYSTEM_DEFAULTS[attr(c, "val") ?? ""];
        break;
      case "prstClr":
        base = PRESET_COLORS[attr(c, "val") ?? ""];
        break;
      case "scrgbClr": {
        const p = (k: string) => Math.round(clamp01((numAttr(c, k) ?? 0) / 100000) * 255);
        base = [p("r"), p("g"), p("b")].map((n) => n.toString(16).padStart(2, "0")).join("");
        break;
      }
      case "hslClr": {
        const [r, g, b] = hslToRgb((numAttr(c, "hue") ?? 0) / 21600000, (numAttr(c, "sat") ?? 0) / 100000, (numAttr(c, "lum") ?? 0) / 100000);
        base = [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
        break;
      }
      default:
        continue;
    }
    if (!base) return undefined;
    return applyColorMods(base, Array.from(c.children));
  }
  return undefined;
}

function parseTheme(xml: string | undefined): Theme {
  const theme: Theme = { colors: {}, fillStyles: [], lineStyles: [], bgFillStyles: [] };
  if (!xml) {
    Object.assign(theme.colors, { dk1: "000000", lt1: "FFFFFF", dk2: "44546A", lt2: "E7E6E6", accent1: "4472C4", accent2: "ED7D31", accent3: "A5A5A5", accent4: "FFC000", accent5: "5B9BD5", accent6: "70AD47", hlink: "0563C1", folHlink: "954F72" });
    return theme;
  }
  const doc = parseXml(xml);
  const scheme = descendants(doc, "clrScheme")[0];
  if (scheme) {
    for (const c of Array.from(scheme.children)) {
      const inner = c.children[0];
      if (!inner) continue;
      const v = inner.localName === "sysClr" ? attr(inner, "lastClr") ?? SYSTEM_DEFAULTS[attr(inner, "val") ?? ""] : attr(inner, "val");
      if (v) theme.colors[c.localName] = v;
    }
  }
  const fonts = descendants(doc, "fontScheme")[0];
  theme.majorFont = attr(path(fonts, "majorFont", "latin"), "typeface");
  theme.minorFont = attr(path(fonts, "minorFont", "latin"), "typeface");
  const fmt = descendants(doc, "fmtScheme")[0];
  theme.fillStyles = Array.from(kid(fmt, "fillStyleLst")?.children ?? []);
  theme.lineStyles = Array.from(kid(fmt, "lnStyleLst")?.children ?? []);
  theme.bgFillStyles = Array.from(kid(fmt, "bgFillStyleLst")?.children ?? []);
  return theme;
}

// ---------------------------------------------------------------- relationships

type Rels = Map<string, { target: string; type: string; external: boolean }>;

function relsPathOf(part: string): string {
  const dir = part.includes("/") ? part.slice(0, part.lastIndexOf("/") + 1) : "";
  return `${dir}_rels/${part.slice(dir.length)}.rels`;
}

function readRels(pkg: ZipPackage, part: string): Rels {
  const rels: Rels = new Map();
  const xml = pkg.text(relsPathOf(part));
  if (!xml) return rels;
  for (const r of descendants(parseXml(xml), "Relationship")) {
    const id = attr(r, "Id");
    const target = attr(r, "Target");
    if (!id || !target) continue;
    const external = attr(r, "TargetMode") === "External";
    rels.set(id, { target: external ? target : resolvePath(part, target), type: attr(r, "Type") ?? "", external });
  }
  return rels;
}

function relOfType(rels: Rels, suffix: string): string | undefined {
  for (const r of rels.values()) if (r.type.endsWith(suffix)) return r.target;
  return undefined;
}

// ---------------------------------------------------------------- fills and lines

function readFill(spPr: Element | undefined, ctx: Ctx, rels: Rels): Fill | null | undefined {
  if (!spPr) return undefined;
  for (const c of Array.from(spPr.children)) {
    switch (c.localName) {
      case "noFill":
        return null;
      case "solidFill": {
        const color = readColor(c, ctx);
        return color ? { color } : undefined;
      }
      case "gradFill": {
        const stops = kids(kid(c, "gsLst"), "gs")
          .map((gs) => ({ pos: (numAttr(gs, "pos") ?? 0) / 1000, color: readColor(gs, ctx) ?? "#000" }))
          .sort((a, b) => a.pos - b.pos);
        if (!stops.length) return undefined;
        const ang = (numAttr(kid(c, "lin"), "ang") ?? 5400000) / 60000;
        return { gradient: { angle: ang, stops }, color: stops[0]!.color };
      }
      case "blipFill": {
        const id = attr(kid(c, "blip"), "embed");
        const rel = id ? rels.get(id) : undefined;
        return rel && !rel.external ? { imagePart: rel.target } : undefined;
      }
      case "pattFill": {
        const color = readColor(kid(c, "fgClr"), ctx);
        return color ? { color } : undefined;
      }
      case "grpFill":
        return undefined;
    }
  }
  return undefined;
}

function readLine(ln: Element | undefined, ctx: Ctx): Line | null | undefined {
  if (!ln) return undefined;
  if (kid(ln, "noFill")) return null;
  const color = readColor(kid(ln, "solidFill"), ctx) ?? readColor(kid(ln, "gradFill") ? kid(kid(kid(ln, "gradFill"), "gsLst"), "gs") : undefined, ctx);
  const w = numAttr(ln, "w");
  if (!color && w === undefined) return undefined;
  return { color: color ?? "#000000", widthPt: Math.max(0.5, (w ?? 9525) / EMU_PER_PT), dash: attr(kid(ln, "prstDash"), "val") };
}

/** Resolve a style matrix reference (a:fillRef / a:lnRef) against the theme. */
function styleRefFill(ref: Element | undefined, ctx: Ctx, rels: Rels): Fill | null | undefined {
  if (!ref) return undefined;
  const idx = numAttr(ref, "idx") ?? 0;
  if (idx === 0) return null;
  const color = readColor(ref, ctx);
  const list = idx >= 1000 ? ctx.theme.bgFillStyles : ctx.theme.fillStyles;
  const entry = list[(idx >= 1000 ? idx - 1001 : idx - 1)];
  if (!entry) return color ? { color } : undefined;
  const wrapper = entry.ownerDocument.createElementNS(entry.namespaceURI, "spPr");
  wrapper.appendChild(entry.cloneNode(true));
  return readFill(wrapper, { ...ctx, phClr: color }, rels) ?? (color ? { color } : undefined);
}

function styleRefLine(ref: Element | undefined, ctx: Ctx): Line | null | undefined {
  if (!ref) return undefined;
  const idx = numAttr(ref, "idx") ?? 0;
  if (idx === 0) return null;
  const color = readColor(ref, ctx);
  const entry = ctx.theme.lineStyles[idx - 1];
  const line = entry ? readLine(entry, { ...ctx, phClr: color }) : undefined;
  return line ?? (color ? { color, widthPt: 0.75 } : undefined);
}

// ---------------------------------------------------------------- text

interface LevelStyle {
  sizePt?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  font?: string;
  align?: Paragraph["align"];
  indentPt?: number;
  marLPt?: number;
  bullet?: string | null;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  lineSpacing?: number;
}

type ListStyle = (LevelStyle | undefined)[]; // index 0..8 => lvl1..lvl9

const ALIGN: Record<string, Paragraph["align"]> = { l: "left", ctr: "center", r: "right", just: "justify", dist: "justify" };

function fontName(latin: Element | undefined, theme: Theme): string | undefined {
  const tf = attr(latin, "typeface");
  if (!tf) return undefined;
  if (tf.startsWith("+mj")) return theme.majorFont;
  if (tf.startsWith("+mn")) return theme.minorFont;
  return tf;
}

function readRunProps(rPr: Element | undefined, ctx: Ctx): Partial<Run> {
  if (!rPr) return {};
  const out: Partial<Run> = {};
  const sz = numAttr(rPr, "sz");
  if (sz) out.sizePt = sz / 100;
  const b = attr(rPr, "b");
  if (b !== undefined) out.bold = b === "1" || b === "true";
  const i = attr(rPr, "i");
  if (i !== undefined) out.italic = i === "1" || i === "true";
  const u = attr(rPr, "u");
  if (u !== undefined) out.underline = u !== "none";
  const strike = attr(rPr, "strike");
  if (strike !== undefined) out.strike = strike !== "noStrike";
  const color = readColor(kid(rPr, "solidFill"), ctx);
  if (color) out.color = color;
  const font = fontName(kid(rPr, "latin"), ctx.theme) ?? fontName(kid(rPr, "ea"), ctx.theme);
  if (font) out.font = font;
  const baseline = numAttr(rPr, "baseline");
  if (baseline) out.baseline = baseline / 1000;
  return out;
}

function spacingPt(el: Element | undefined, sizePt: number): number | undefined {
  if (!el) return undefined;
  const pts = numAttr(kid(el, "spcPts"), "val");
  if (pts !== undefined) return pts / 100;
  const pct = numAttr(kid(el, "spcPct"), "val");
  if (pct !== undefined) return (pct / 100000) * sizePt;
  return undefined;
}

function readLevelStyle(pPr: Element | undefined, ctx: Ctx): LevelStyle | undefined {
  if (!pPr) return undefined;
  const s: LevelStyle = { ...readRunProps(kid(pPr, "defRPr"), ctx) };
  const algn = attr(pPr, "algn");
  if (algn && ALIGN[algn]) s.align = ALIGN[algn];
  const marL = numAttr(pPr, "marL");
  if (marL !== undefined) s.marLPt = marL / EMU_PER_PT;
  const indent = numAttr(pPr, "indent");
  if (indent !== undefined) s.indentPt = indent / EMU_PER_PT;
  if (kid(pPr, "buNone")) s.bullet = null;
  const buChar = attr(kid(pPr, "buChar"), "char");
  if (buChar) s.bullet = buChar;
  if (kid(pPr, "buAutoNum")) s.bullet = "#";
  const before = spacingPt(kid(pPr, "spcBef"), s.sizePt ?? 18);
  if (before !== undefined) s.spaceBeforePt = before;
  const after = spacingPt(kid(pPr, "spcAft"), s.sizePt ?? 18);
  if (after !== undefined) s.spaceAfterPt = after;
  const ln = numAttr(kid(kid(pPr, "lnSpc"), "spcPct"), "val");
  if (ln !== undefined) s.lineSpacing = ln / 100000;
  return s;
}

function readListStyle(lst: Element | undefined, ctx: Ctx): ListStyle {
  const out: ListStyle = [];
  if (!lst) return out;
  for (let i = 1; i <= 9; i++) out[i - 1] = readLevelStyle(kid(lst, `lvl${i}pPr`), ctx);
  return out;
}

function merge(...styles: (LevelStyle | undefined)[]): LevelStyle {
  const out: LevelStyle = {};
  for (const s of styles) {
    if (!s) continue;
    for (const [k, v] of Object.entries(s)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function readBodyProps(bodyPr: Element | undefined, inherited?: Partial<TextBody>): Omit<TextBody, "paragraphs"> {
  const anchorAttr = attr(bodyPr, "anchor");
  const anchor = anchorAttr === "ctr" ? "middle" : anchorAttr === "b" ? "bottom" : anchorAttr === "t" ? "top" : inherited?.anchor ?? "top";
  const ins = (k: string, d: number) => {
    const v = numAttr(bodyPr, k);
    return v !== undefined ? v / EMU_PER_PT : d;
  };
  const d = inherited?.insetsPt ?? [7.2, 3.6, 7.2, 3.6];
  const vert = attr(bodyPr, "vert");
  return {
    anchor,
    insetsPt: [ins("lIns", d[0]), ins("tIns", d[1]), ins("rIns", d[2]), ins("bIns", d[3])],
    wrap: attr(bodyPr, "wrap") !== "none" && (inherited?.wrap ?? true),
    vertical: vert ? vert !== "horz" : inherited?.vertical ?? false,
  };
}

/** Text body of a shape. `levels` holds inherited paragraph styles from lowest to highest priority. */
function readTextBody(txBody: Element | undefined, ctx: Ctx, levels: ListStyle[], inheritedBody?: Partial<TextBody>): TextBody | undefined {
  if (!txBody) return undefined;
  const bodyPr = kid(txBody, "bodyPr");
  const props = readBodyProps(bodyPr, inheritedBody);
  const own = readListStyle(kid(txBody, "lstStyle"), ctx);
  const autofit = kid(bodyPr, "normAutofit");
  const fontScale = (numAttr(autofit, "fontScale") ?? 100000) / 100000;
  const lnReduction = (numAttr(autofit, "lnSpcReduction") ?? 0) / 100000;
  const paragraphs: Paragraph[] = [];
  let autoNum = 0;
  for (const p of kids(txBody, "p")) {
    const pPr = kid(p, "pPr");
    const level = Math.min(8, numAttr(pPr, "lvl") ?? 0);
    const style = merge(...levels.map((l) => l[level]), own[level], readLevelStyle(pPr, ctx));
    const runs: Run[] = [];
    for (const r of Array.from(p.children)) {
      if (r.localName === "r" || r.localName === "fld") {
        const rp = merge(style, readRunProps(kid(r, "rPr"), ctx));
        const text = kid(r, "t")?.textContent ?? "";
        runs.push({
          text,
          sizePt: (rp.sizePt ?? 18) * fontScale,
          bold: rp.bold, italic: rp.italic, color: rp.color, font: rp.font,
          underline: (rp as Run).underline, strike: (rp as Run).strike, baseline: (rp as Run).baseline,
        });
      } else if (r.localName === "br") {
        runs.push({ text: "\n", isBreak: true, sizePt: (style.sizePt ?? 18) * fontScale });
      }
    }
    const endProps = merge(style, readRunProps(kid(p, "endParaRPr"), ctx));
    const hasText = runs.some((r) => r.text.trim().length > 0);
    let bullet: string | undefined;
    if (hasText && style.bullet) {
      if (style.bullet === "#") bullet = `${++autoNum}.`;
      else bullet = style.bullet;
    }
    if (!hasText) autoNum = 0;
    paragraphs.push({
      align: style.align ?? "left",
      level,
      bullet,
      indentPt: style.marLPt ?? level * 27,
      spaceBeforePt: style.spaceBeforePt ?? 0,
      spaceAfterPt: style.spaceAfterPt ?? 0,
      lineSpacing: style.lineSpacing !== undefined ? Math.max(0.5, style.lineSpacing - lnReduction) : undefined,
      runs,
      endSizePt: (endProps.sizePt ?? style.sizePt ?? 18) * fontScale,
    });
  }
  return { ...props, paragraphs };
}

// ---------------------------------------------------------------- placeholders and layouts

interface PhInfo {
  type: string;
  idx?: string;
}

function placeholderOf(sp: Element): PhInfo | undefined {
  const nv = Array.from(sp.children).find((c) => c.localName.startsWith("nv"));
  const ph = kid(kid(nv, "nvPr"), "ph");
  if (!ph) return undefined;
  return { type: attr(ph, "type") ?? "body", idx: attr(ph, "idx") };
}

interface LayerShape {
  ph: PhInfo;
  box?: Box;
  lstStyle: ListStyle;
  body?: Partial<TextBody>;
  fill?: Fill | null;
  line?: Line | null;
}

interface Layer {
  part: string;
  doc: Document;
  rels: Rels;
  shapes: LayerShape[];
  background?: Fill;
  ctx: Ctx;
}

function readXfrm(xfrm: Element | undefined): Box | undefined {
  if (!xfrm) return undefined;
  const off = kid(xfrm, "off");
  const ext = kid(xfrm, "ext");
  if (!off || !ext) return undefined;
  return {
    x: (numAttr(off, "x") ?? 0) / EMU_PER_PT,
    y: (numAttr(off, "y") ?? 0) / EMU_PER_PT,
    w: (numAttr(ext, "cx") ?? 0) / EMU_PER_PT,
    h: (numAttr(ext, "cy") ?? 0) / EMU_PER_PT,
    rot: (numAttr(xfrm, "rot") ?? 0) / 60000,
    flipH: attr(xfrm, "flipH") === "1",
    flipV: attr(xfrm, "flipV") === "1",
  };
}

function matchPlaceholder(shapes: LayerShape[], ph: PhInfo): LayerShape | undefined {
  const typeOf = (t: string) => (t === "ctrTitle" ? "title" : t === "subTitle" ? "body" : t === "obj" ? "body" : t);
  if (ph.idx !== undefined) {
    const byIdx = shapes.find((s) => s.ph.idx === ph.idx && (ph.type === "body" || typeOf(s.ph.type) === typeOf(ph.type) || s.ph.type === "body" || s.ph.type === "obj"));
    if (byIdx) return byIdx;
  }
  return shapes.find((s) => s.ph.type === ph.type) ?? shapes.find((s) => typeOf(s.ph.type) === typeOf(ph.type));
}

function readBackground(cSld: Element | undefined, ctx: Ctx, rels: Rels): Fill | undefined {
  const bg = kid(cSld, "bg");
  if (!bg) return undefined;
  const bgPr = kid(bg, "bgPr");
  if (bgPr) return readFill(bgPr, ctx, rels) ?? undefined;
  const ref = kid(bg, "bgRef");
  if (ref) return styleRefFill(ref, ctx, rels) ?? undefined;
  return undefined;
}

function readClrMap(el: Element | undefined): Record<string, string> | undefined {
  if (!el) return undefined;
  const map: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) map[a.localName] = a.value;
  return map;
}

function loadLayer(pkg: ZipPackage, part: string, theme: Theme, clrMap: Record<string, string>): Layer | undefined {
  const xml = pkg.text(part);
  if (!xml) return undefined;
  const doc = parseXml(xml);
  const rels = readRels(pkg, part);
  const override = readClrMap(kid(path(doc, "clrMapOvr"), "overrideClrMapping"));
  const ctx: Ctx = { theme, clrMap: override ?? clrMap };
  const shapes: LayerShape[] = [];
  const spTree = path(doc.documentElement, "cSld", "spTree");
  for (const sp of Array.from(spTree?.children ?? [])) {
    if (sp.localName !== "sp") continue;
    const ph = placeholderOf(sp);
    if (!ph) continue;
    const spPr = kid(sp, "spPr");
    const txBody = kid(sp, "txBody");
    shapes.push({
      ph,
      box: readXfrm(kid(spPr, "xfrm")),
      lstStyle: readListStyle(kid(txBody, "lstStyle"), ctx),
      body: txBody ? readBodyProps(kid(txBody, "bodyPr")) : undefined,
      fill: readFill(spPr, ctx, rels),
      line: readLine(kid(spPr, "ln"), ctx),
    });
  }
  return { part, doc, rels, shapes, background: readBackground(kid(doc.documentElement, "cSld"), ctx, rels), ctx };
}

// ---------------------------------------------------------------- slide elements

interface Transform {
  // maps child coordinates into slide points: x' = ox + (x - cx) * sx
  ox: number; oy: number; cx: number; cy: number; sx: number; sy: number;
}

const IDENTITY: Transform = { ox: 0, oy: 0, cx: 0, cy: 0, sx: 1, sy: 1 };

function applyTransform(b: Box, t: Transform): Box {
  return { ...b, x: t.ox + (b.x - t.cx) * t.sx, y: t.oy + (b.y - t.cy) * t.sy, w: b.w * t.sx, h: b.h * t.sy };
}

interface SlideScope {
  pkg: ZipPackage;
  rels: Rels;
  ctx: Ctx;
  layout?: Layer;
  master?: Layer;
  masterText: { title: ListStyle; body: ListStyle; other: ListStyle };
  warnings: string[];
}

function textLevelsFor(ph: PhInfo | undefined, scope: SlideScope, layoutShape?: LayerShape, masterShape?: LayerShape): ListStyle[] {
  const t = ph?.type;
  const base = !ph ? scope.masterText.other : t === "title" || t === "ctrTitle" ? scope.masterText.title : scope.masterText.body;
  return [base, masterShape?.lstStyle ?? [], layoutShape?.lstStyle ?? []];
}

function readShape(sp: Element, scope: SlideScope, t: Transform, out: SlideElement[]): void {
  const spPr = kid(sp, "spPr");
  const ph = placeholderOf(sp);
  const layoutShape = ph && scope.layout ? matchPlaceholder(scope.layout.shapes, ph) : undefined;
  const masterShape = ph && scope.master ? matchPlaceholder(scope.master.shapes, layoutShape?.ph ?? ph) : undefined;
  const ownBox = readXfrm(kid(spPr, "xfrm"));
  const box = ownBox ?? layoutShape?.box ?? masterShape?.box;
  if (!box) return; // nothing to place
  const style = kid(sp, "style");
  let fill = readFill(spPr, scope.ctx, scope.rels);
  if (fill === undefined) fill = layoutShape?.fill ?? masterShape?.fill;
  if (fill === undefined) fill = styleRefFill(kid(style, "fillRef"), scope.ctx, scope.rels);
  let line = readLine(kid(spPr, "ln"), scope.ctx);
  if (line === undefined) line = layoutShape?.line ?? masterShape?.line;
  if (line === undefined) line = styleRefLine(kid(style, "lnRef"), scope.ctx);
  const fontRefColor = readColor(kid(style, "fontRef"), scope.ctx);
  const levels = textLevelsFor(ph, scope, layoutShape, masterShape);
  if (fontRefColor) levels.unshift([...Array(9)].map(() => ({ color: fontRefColor })));
  const inheritedBody = { ...masterShape?.body, ...layoutShape?.body };
  const text = readTextBody(kid(sp, "txBody"), scope.ctx, levels, inheritedBody);
  const geomEl = kid(spPr, "prstGeom");
  const geom = attr(geomEl, "prst") ?? (kid(spPr, "custGeom") ? "rect" : "rect");
  const gd = descendants(geomEl, "gd")[0];
  const adjVal = gd ? Number((attr(gd, "fmla") ?? "").replace(/^val\s+/, "")) : undefined;
  const hasText = text?.paragraphs.some((p) => p.runs.some((r) => r.text.trim()));
  // Empty placeholders are prompts in edit mode ("Click to add title"); they do not render in a show.
  if (ph && !hasText && !fill && !line) return;
  out.push({
    type: "shape",
    ...applyTransform(box, t),
    geom,
    fill: fill ?? undefined,
    line: line ?? undefined,
    text: hasText ? text : undefined,
    adj: Number.isFinite(adjVal) ? adjVal : undefined,
  });
}

function readPicture(pic: Element, scope: SlideScope, t: Transform, out: SlideElement[]): void {
  const blipFill = kid(pic, "blipFill");
  const id = attr(kid(blipFill, "blip"), "embed");
  const rel = id ? scope.rels.get(id) : undefined;
  const ph = placeholderOf(pic);
  const layoutShape = ph && scope.layout ? matchPlaceholder(scope.layout.shapes, ph) : undefined;
  const box = readXfrm(kid(kid(pic, "spPr"), "xfrm")) ?? layoutShape?.box;
  if (!box) return;
  if (!rel || rel.external) {
    out.push({ type: "placeholder", ...applyTransform(box, t), label: rel?.external ? "Linked picture" : "Picture" });
    return;
  }
  const src = kid(blipFill, "srcRect");
  const crop = src
    ? { l: (numAttr(src, "l") ?? 0) / 100000, t: (numAttr(src, "t") ?? 0) / 100000, r: (numAttr(src, "r") ?? 0) / 100000, b: (numAttr(src, "b") ?? 0) / 100000 }
    : undefined;
  const nvPr = kid(kid(pic, "nvPicPr"), "nvPr");
  const isMedia = !!(kid(nvPr, "videoFile") || kid(nvPr, "audioFile") || descendants(nvPr, "media")[0]);
  out.push({ type: "image", ...applyTransform(box, t), part: rel.target, crop });
  if (isMedia) out.push({ type: "placeholder", ...applyTransform(box, t), label: "▶ Media (poster frame)" });
}

function readTable(frame: Element, box: Box, scope: SlideScope, out: SlideElement[]): void {
  const tbl = descendants(frame, "tbl")[0];
  if (!tbl) return;
  const colWidths = kids(kid(tbl, "tblGrid"), "gridCol").map((c) => (numAttr(c, "w") ?? 0) / EMU_PER_PT);
  const rows: TableEl["rows"] = [];
  const tblPr = kid(tbl, "tblPr");
  const banded = attr(tblPr, "bandRow") === "1";
  const firstRow = attr(tblPr, "firstRow") === "1";
  const accent = scope.ctx.theme.colors["accent1"] ?? "4472C4";
  kids(tbl, "tr").forEach((tr, ri) => {
    const cells: TableCell[] = kids(tr, "tc").map((tc) => {
      const tcPr = kid(tc, "tcPr");
      let fill = readFill(tcPr, scope.ctx, scope.rels) ?? undefined;
      if (!fill && firstRow && ri === 0) fill = { color: "#" + accent };
      else if (!fill && banded && ri % 2 === (firstRow ? 1 : 0)) fill = { color: applyColorMods(accent, [mod(tbl.ownerDocument, "tint", 40000)]) };
      const border = (k: string) => readLine(kid(tcPr, k), scope.ctx) ?? undefined;
      const levels: ListStyle[] = [scope.masterText.other];
      if (firstRow && ri === 0) levels.push([...Array(9)].map(() => ({ color: "#FFFFFF", bold: true })));
      const text = readTextBody(kid(tc, "txBody"), scope.ctx, levels) ?? { paragraphs: [], anchor: "top", insetsPt: [7.2, 3.6, 7.2, 3.6], wrap: true, vertical: false };
      const marL = numAttr(tcPr, "marL"), marR = numAttr(tcPr, "marR"), marT = numAttr(tcPr, "marT"), marB = numAttr(tcPr, "marB");
      text.insetsPt = [marL !== undefined ? marL / EMU_PER_PT : 7.2, marT !== undefined ? marT / EMU_PER_PT : 3.6, marR !== undefined ? marR / EMU_PER_PT : 7.2, marB !== undefined ? marB / EMU_PER_PT : 3.6];
      const anchor = attr(tcPr, "anchor");
      if (anchor) text.anchor = anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : "top";
      return {
        text,
        fill,
        gridSpan: numAttr(tc, "gridSpan") ?? 1,
        rowSpan: numAttr(tc, "rowSpan") ?? 1,
        merged: attr(tc, "hMerge") === "1" || attr(tc, "vMerge") === "1",
        borders: { l: border("lnL"), r: border("lnR"), t: border("lnT"), b: border("lnB") },
      };
    });
    rows.push({ h: (numAttr(tr, "h") ?? 0) / EMU_PER_PT, cells });
  });
  out.push({ type: "table", ...box, colWidths, rows });
}

function mod(doc: Document, name: string, val: number): Element {
  const el = doc.createElementNS("http://schemas.openxmlformats.org/drawingml/2006/main", name);
  el.setAttribute("val", String(val));
  return el;
}

function readGraphicFrame(frame: Element, scope: SlideScope, t: Transform, out: SlideElement[]): void {
  const box0 = readXfrm(kid(frame, "xfrm"));
  if (!box0) return;
  const box = applyTransform(box0, t);
  const data = descendants(frame, "graphicData")[0];
  const uri = attr(data, "uri") ?? "";
  if (uri.endsWith("/table")) return readTable(frame, box, scope, out);
  if (uri.includes("chart")) return void out.push({ type: "placeholder", ...box, label: "Chart" });
  if (uri.includes("diagram")) {
    // SmartArt keeps a pre-rendered drawing part; render it when present.
    const relIds = descendants(data, "relIds")[0];
    const dmId = attr(relIds, "dm");
    const dataPart = dmId ? scope.rels.get(dmId)?.target : undefined;
    const drawingPart = dataPart ? findDiagramDrawing(scope, dataPart) : undefined;
    if (drawingPart) {
      const xml = scope.pkg.text(drawingPart);
      if (xml) {
        const doc = parseXml(xml);
        const tree = descendants(doc, "spTree")[0];
        const rels = readRels(scope.pkg, drawingPart);
        if (tree) {
          walkTree(tree, { ...scope, rels }, { ox: box.x, oy: box.y, cx: 0, cy: 0, sx: 1, sy: 1 }, out);
          return;
        }
      }
    }
    return void out.push({ type: "placeholder", ...box, label: "Diagram" });
  }
  if (uri.includes("ole")) {
    const fallbackPic = descendants(frame, "pic")[0];
    if (fallbackPic) return readPicture(fallbackPic, scope, t, out);
    return void out.push({ type: "placeholder", ...box, label: "Embedded object" });
  }
  out.push({ type: "placeholder", ...box, label: "Object" });
}

function findDiagramDrawing(scope: SlideScope, dataPart: string): string | undefined {
  for (const r of scope.rels.values()) if (r.type.endsWith("/diagramDrawing")) return r.target;
  const guess = dataPart.replace(/data(\d+)\.xml$/, "drawing$1.xml");
  return scope.pkg.has(guess) ? guess : undefined;
}

function walkTree(tree: Element, scope: SlideScope, t: Transform, out: SlideElement[]): void {
  for (const el of Array.from(tree.children)) {
    try {
      switch (el.localName) {
        case "sp":
          readShape(el, scope, t, out);
          break;
        case "cxnSp":
          readShape(el, scope, t, out);
          break;
        case "pic":
          readPicture(el, scope, t, out);
          break;
        case "graphicFrame":
          readGraphicFrame(el, scope, t, out);
          break;
        case "grpSp": {
          const x = kid(kid(el, "grpSpPr"), "xfrm");
          const box = readXfrm(x);
          const chOff = kid(x, "chOff"), chExt = kid(x, "chExt");
          if (!box || !chOff || !chExt) {
            walkTree(el, scope, t, out);
            break;
          }
          const cw = (numAttr(chExt, "cx") ?? 0) / EMU_PER_PT, ch = (numAttr(chExt, "cy") ?? 0) / EMU_PER_PT;
          const outer = applyTransform(box, t);
          walkTree(el, scope, {
            ox: outer.x, oy: outer.y,
            cx: (numAttr(chOff, "x") ?? 0) / EMU_PER_PT, cy: (numAttr(chOff, "y") ?? 0) / EMU_PER_PT,
            sx: cw ? outer.w / cw : 1, sy: ch ? outer.h / ch : 1,
          }, out);
          break;
        }
        case "AlternateContent": {
          const choice = kid(el, "Fallback") ?? kid(el, "Choice");
          if (choice) walkTree(choice, scope, t, out);
          break;
        }
        case "contentPart":
          break;
      }
    } catch (err) {
      scope.warnings.push(`Skipped a ${el.localName}: ${(err as Error).message}`);
    }
  }
}

function masterTextStyles(master: Layer | undefined): SlideScope["masterText"] {
  const tx = master ? path(master.doc.documentElement, "txStyles") : undefined;
  const ctx = master?.ctx;
  if (!tx || !ctx) return { title: [{ sizePt: 44 }], body: [{ sizePt: 28 }, { sizePt: 24 }, { sizePt: 20 }, { sizePt: 18 }, { sizePt: 18 }], other: [{ sizePt: 18 }] };
  return {
    title: readListStyle(kid(tx, "titleStyle"), ctx),
    body: readListStyle(kid(tx, "bodyStyle"), ctx),
    other: readListStyle(kid(tx, "otherStyle"), ctx),
  };
}

/** Master and layout shapes that are not placeholders (logos, bars) draw behind slide content. */
function decorations(layer: Layer | undefined, scope: SlideScope): SlideElement[] {
  if (!layer) return [];
  const tree = path(layer.doc.documentElement, "cSld", "spTree");
  if (!tree) return [];
  const filtered = tree.cloneNode(true) as Element;
  for (const c of Array.from(filtered.children)) {
    if ((c.localName === "sp" || c.localName === "pic") && placeholderOf(c)) filtered.removeChild(c);
  }
  const out: SlideElement[] = [];
  walkTree(filtered, { ...scope, rels: layer.rels, ctx: layer.ctx, layout: undefined, master: undefined }, IDENTITY, out);
  return out;
}

function notesText(pkg: ZipPackage, rels: Rels): string | undefined {
  const notesPart = relOfType(rels, "/notesSlide");
  if (!notesPart) return undefined;
  const xml = pkg.text(notesPart);
  if (!xml) return undefined;
  const doc = parseXml(xml);
  const parts: string[] = [];
  for (const sp of descendants(doc, "sp")) {
    const ph = placeholderOf(sp);
    if (ph?.type !== "body") continue;
    for (const p of descendants(sp, "p")) parts.push(descendants(p, "t").map((t) => t.textContent ?? "").join(""));
  }
  const text = parts.join("\n").trim();
  return text || undefined;
}

// ---------------------------------------------------------------- entry point

/** Parse a .pptx into a render model. Throws CorruptFileError when it is not a presentation. */
export function parsePptx(data: ArrayBuffer | Uint8Array): Presentation {
  const pkg = new ZipPackage(data);
  const presPart = "ppt/presentation.xml";
  const presXml = pkg.text(presPart);
  if (!presXml) throw new CorruptFileError("This file has no ppt/presentation.xml, so it is not a PowerPoint presentation.");
  const pres = parseXml(presXml);
  const presRels = readRels(pkg, presPart);
  const sldSz = kid(pres.documentElement, "sldSz");
  const widthPt = (numAttr(sldSz, "cx") ?? 12192000) / EMU_PER_PT;
  const heightPt = (numAttr(sldSz, "cy") ?? 6858000) / EMU_PER_PT;
  const warnings: string[] = [];
  const themeCache = new Map<string, Theme>();
  const layerCache = new Map<string, Layer | undefined>();

  const slides: Slide[] = [];
  const ids = kids(kid(pres.documentElement, "sldIdLst"), "sldId");
  ids.forEach((sldId, i) => {
    // p:sldId carries both id="256" and r:id="rId2"; the relationship id is the prefixed one.
    const rid = Array.from(sldId.attributes).find((a) => a.localName === "id" && a.prefix)?.value;
    const slidePart = rid ? presRels.get(rid)?.target : undefined;
    if (!slidePart) {
      warnings.push(`Slide ${i + 1} has no part.`);
      return;
    }
    try {
      const xml = pkg.text(slidePart);
      if (!xml) throw new Error("missing part");
      const doc = parseXml(xml);
      const rels = readRels(pkg, slidePart);
      const layoutPart = relOfType(rels, "/slideLayout");
      const layoutRels = layoutPart ? readRels(pkg, layoutPart) : new Map();
      const masterPart = relOfType(layoutRels, "/slideMaster");
      const masterRels = masterPart ? readRels(pkg, masterPart) : new Map();
      const themePart = relOfType(masterRels, "/theme");
      let theme = themePart ? themeCache.get(themePart) : undefined;
      if (!theme) {
        theme = parseTheme(themePart ? pkg.text(themePart) : undefined);
        if (themePart) themeCache.set(themePart, theme);
      }
      const masterXml = masterPart ? pkg.text(masterPart) : undefined;
      const masterClrMap = masterXml ? readClrMap(kid(parseXml(masterXml).documentElement, "clrMap")) : undefined;
      const clrMap = masterClrMap ?? { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };
      const key = (p: string) => `${p}|${themePart}`;
      if (masterPart && !layerCache.has(key(masterPart))) layerCache.set(key(masterPart), loadLayer(pkg, masterPart, theme, clrMap));
      if (layoutPart && !layerCache.has(key(layoutPart))) layerCache.set(key(layoutPart), loadLayer(pkg, layoutPart, theme, clrMap));
      const master = masterPart ? layerCache.get(key(masterPart)) : undefined;
      const layout = layoutPart ? layerCache.get(key(layoutPart)) : undefined;
      const slideOverride = readClrMap(kid(path(doc, "clrMapOvr"), "overrideClrMapping"));
      const ctx: Ctx = { theme, clrMap: slideOverride ?? layout?.ctx.clrMap ?? clrMap };
      const scope: SlideScope = { pkg, rels, ctx, layout, master, masterText: masterTextStyles(master), warnings };
      const cSld = kid(doc.documentElement, "cSld");
      const background = readBackground(cSld, ctx, rels) ?? layout?.background ?? master?.background ?? { color: "#FFFFFF" };
      const elements: SlideElement[] = [];
      const showMasterShapes = attr(doc.documentElement, "showMasterSp") !== "0";
      if (showMasterShapes) {
        if (layout && attr(layout.doc.documentElement, "showMasterSp") !== "0") elements.push(...decorations(master, scope));
        elements.push(...decorations(layout, scope));
      }
      const tree = kid(cSld, "spTree");
      if (tree) walkTree(tree, scope, IDENTITY, elements);
      slides.push({ index: i, background, elements, notes: notesText(pkg, rels), hidden: attr(doc.documentElement, "show") === "0" });
    } catch (err) {
      warnings.push(`Slide ${i + 1} could not be read: ${(err as Error).message}`);
      slides.push({ index: i, background: { color: "#FFFFFF" }, elements: [{ type: "placeholder", x: 0, y: 0, w: widthPt, h: heightPt, rot: 0, flipH: false, flipV: false, label: "This slide could not be read" }], hidden: false });
    }
  });

  const thumb = pkg.resolve("docProps/thumbnail.jpeg") ?? pkg.resolve("docProps/thumbnail.png");
  return { widthPt, heightPt, slides, thumbnailPart: thumb, pkg, warnings };
}
