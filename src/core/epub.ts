import DOMPurify from "dompurify";
import { CorruptFileError } from "./errors";
import { attr, descendants, kid, kids, parseXml } from "./xml";
import { ZipPackage, resolvePath } from "./zip";

export interface TocEntry {
  title: string;
  href: string; // part path, without fragment
  fragment?: string;
  depth: number;
}

export interface Book {
  title: string;
  author?: string;
  language?: string;
  spine: { part: string; mediaType: string }[];
  toc: TocEntry[];
  coverPart?: string;
  pkg: ZipPackage;
  /** media types by part path */
  types: Map<string, string>;
}

export function parseEpub(data: ArrayBuffer | Uint8Array): Book {
  const pkg = new ZipPackage(data);
  const container = pkg.text("META-INF/container.xml");
  if (!container) throw new CorruptFileError("This EPUB has no META-INF/container.xml.");
  const rootfile = descendants(parseXml(container), "rootfile")[0];
  const opfPath = attr(rootfile, "full-path");
  if (!opfPath) throw new CorruptFileError("This EPUB does not name its package file.");
  const opfXml = pkg.text(opfPath);
  if (!opfXml) throw new CorruptFileError(`This EPUB's package file ${opfPath} is missing.`);
  const opf = parseXml(opfXml);
  const metadata = descendants(opf, "metadata")[0];
  const title = descendants(metadata, "title")[0]?.textContent?.trim() || "Untitled book";
  const author = descendants(metadata, "creator")[0]?.textContent?.trim() || undefined;
  const language = descendants(metadata, "language")[0]?.textContent?.trim() || undefined;

  const manifest = new Map<string, { href: string; type: string; props: string }>();
  const types = new Map<string, string>();
  for (const item of descendants(opf, "item")) {
    const id = attr(item, "id");
    const href = attr(item, "href");
    if (!id || !href) continue;
    const full = resolvePath(opfPath, href);
    const type = attr(item, "media-type") ?? "";
    manifest.set(id, { href: full, type, props: attr(item, "properties") ?? "" });
    types.set(full, type);
  }

  const spineEl = descendants(opf, "spine")[0];
  const spine = kids(spineEl, "itemref")
    .filter((ref) => attr(ref, "linear") !== "no")
    .map((ref) => manifest.get(attr(ref, "idref") ?? ""))
    .filter((m): m is { href: string; type: string; props: string } => !!m && pkg.has(m.href))
    .map((m) => ({ part: m.href, mediaType: m.type }));
  if (!spine.length) throw new CorruptFileError("This EPUB has no readable chapters.");

  let coverPart: string | undefined;
  for (const m of manifest.values()) if (m.props.split(/\s+/).includes("cover-image")) coverPart = m.href;
  if (!coverPart) {
    const coverId = descendants(metadata, "meta").find((m) => attr(m, "name") === "cover");
    const ref = coverId ? manifest.get(attr(coverId, "content") ?? "") : undefined;
    if (ref) coverPart = ref.href;
  }

  let toc: TocEntry[] = [];
  const nav = [...manifest.values()].find((m) => m.props.split(/\s+/).includes("nav"));
  if (nav) toc = readNav(pkg, nav.href);
  if (!toc.length) {
    const ncxId = attr(spineEl, "toc");
    const ncx = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((m) => m.type === "application/x-dtbncx+xml");
    if (ncx) toc = readNcx(pkg, ncx.href);
  }
  if (!toc.length) toc = spine.map((s, i) => ({ title: `Section ${i + 1}`, href: s.part, depth: 0 }));
  return { title, author, language, spine, toc, coverPart, pkg, types };
}

function splitHref(base: string, href: string): { href: string; fragment?: string } {
  const [p, frag] = href.split("#");
  return { href: p ? resolvePath(base, p) : base, fragment: frag || undefined };
}

function readNav(pkg: ZipPackage, navPath: string): TocEntry[] {
  const xml = pkg.text(navPath);
  if (!xml) return [];
  let doc: Document;
  try {
    doc = parseXml(xml);
  } catch {
    doc = new DOMParser().parseFromString(xml, "text/html");
  }
  const navs = descendants(doc, "nav");
  const tocNav = navs.find((n) => Array.from(n.attributes).some((a) => a.localName === "type" && a.value.includes("toc"))) ?? navs[0];
  const out: TocEntry[] = [];
  const walk = (ol: Element | undefined, depth: number) => {
    for (const li of kids(ol, "li")) {
      const a = kid(li, "a") ?? kid(li, "span");
      const href = a ? attr(a, "href") : undefined;
      if (a && href) out.push({ title: a.textContent?.trim() || "Untitled", depth, ...splitHref(navPath, href) });
      walk(kid(li, "ol"), depth + 1);
    }
  };
  walk(kid(tocNav, "ol"), 0);
  return out;
}

function readNcx(pkg: ZipPackage, ncxPath: string): TocEntry[] {
  const xml = pkg.text(ncxPath);
  if (!xml) return [];
  const doc = parseXml(xml);
  const out: TocEntry[] = [];
  const walk = (parent: Element | undefined, depth: number) => {
    for (const np of kids(parent, "navPoint")) {
      const label = descendants(kid(np, "navLabel"), "text")[0]?.textContent?.trim() ?? "Untitled";
      const src = attr(kid(np, "content"), "src");
      if (src) out.push({ title: label, depth, ...splitHref(ncxPath, src) });
      walk(np, depth + 1);
    }
  };
  walk(descendants(doc, "navMap")[0], 0);
  return out;
}

const URL_ATTRS = ["src", "href", "poster", "xlink:href"];

/**
 * Build a self-contained, script-free HTML document for one chapter.
 * `urlFor(part)` returns a blob: URL for a package resource (images, CSS, fonts).
 */
export function chapterHtml(book: Book, part: string, urlFor: (part: string) => string | undefined): string {
  const raw = book.pkg.text(part);
  if (raw === undefined) throw new CorruptFileError(`Chapter ${part} is missing from the book.`);
  const isXhtml = (book.types.get(part) ?? "").includes("xhtml") || /\.x?html?$/i.test(part);
  let doc: Document;
  try {
    doc = isXhtml ? parseXml(raw) : new DOMParser().parseFromString(raw, "text/html");
  } catch {
    doc = new DOMParser().parseFromString(raw, "text/html");
  }
  // Inline linked stylesheets so the sandboxed frame needs no network or file access.
  const styles: string[] = [];
  for (const link of descendants(doc, "link")) {
    if ((attr(link, "rel") ?? "").toLowerCase().includes("stylesheet")) {
      const href = attr(link, "href");
      const css = href ? book.pkg.text(resolvePath(part, href)) : undefined;
      if (css) styles.push(rewriteCssUrls(css, resolvePath(part, href!), urlFor));
    }
  }
  for (const st of descendants(doc, "style")) styles.push(rewriteCssUrls(st.textContent ?? "", part, urlFor));
  const body = descendants(doc, "body")[0] ?? doc.documentElement;
  for (const el of Array.from(body.getElementsByTagName("*"))) {
    for (const name of URL_ATTRS) {
      const v = el.getAttribute(name) ?? (name === "xlink:href" ? attr(el, "href") : null);
      if (!v || /^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith("#")) continue;
      const target = resolvePath(part, v);
      if (el.localName === "a") {
        el.setAttribute("href", `#uniview-part:${encodeURIComponent(target)}${v.includes("#") ? "#" + v.split("#")[1] : ""}`);
        continue;
      }
      const url = urlFor(target);
      if (url) el.setAttribute(name === "xlink:href" ? "href" : name, url);
    }
  }
  const bodyHtml = new XMLSerializer().serializeToString(body).replace(/^<body[^>]*>|<\/body>$/g, "");
  const clean = DOMPurify.sanitize(bodyHtml, {
    WHOLE_DOCUMENT: false,
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "base", "meta", "link"],
    FORBID_ATTR: ["srcset"],
    ALLOWED_URI_REGEXP: /^(?:blob:|#|data:image\/)/i,
    ADD_TAGS: ["svg", "image"],
    ADD_ATTR: ["xlink:href", "epub:type"],
  });
  const safeCss = styles.join("\n").replace(/@import[^;]+;/g, "").replace(/expression\s*\(/gi, "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; font-src blob: data:; media-src blob:"><style>html{font:18px/1.6 Georgia,serif;color-scheme:light dark}body{max-width:42em;margin:0 auto;padding:2em 1.5em}img,svg{max-width:100%;height:auto}</style><style>${safeCss}</style></head><body>${clean}</body></html>`;
}

function rewriteCssUrls(css: string, cssPart: string, urlFor: (p: string) => string | undefined): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, _q, u: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u.startsWith("data:") ? m : "none";
    const url = urlFor(resolvePath(cssPart, u));
    return url ? `url("${url}")` : "none";
  });
}
