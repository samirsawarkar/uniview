/** Small helpers over DOMParser for namespaced OOXML and EPUB documents. */

export function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) throw new Error(`Malformed XML: ${err.textContent?.slice(0, 200) ?? "parse error"}`);
  return doc;
}

/** Direct children with the given local name, ignoring namespace prefixes. */
export function kids(el: Element | Document | null | undefined, local: string): Element[] {
  if (!el) return [];
  const out: Element[] = [];
  const children = "children" in el ? el.children : (el as Document).documentElement ? [(el as Document).documentElement] : [];
  for (const c of Array.from(children)) if (c.localName === local) out.push(c);
  return out;
}

export function kid(el: Element | Document | null | undefined, local: string): Element | undefined {
  return kids(el, local)[0];
}

/** Follow a path of local names through direct children. */
export function path(el: Element | Document | null | undefined, ...locals: string[]): Element | undefined {
  let cur: Element | Document | undefined | null = el;
  for (const l of locals) {
    cur = kid(cur, l);
    if (!cur) return undefined;
  }
  return cur as Element | undefined;
}

/** All descendants with the given local name. */
export function descendants(el: Element | Document | null | undefined, local: string): Element[] {
  if (!el) return [];
  return Array.from(el.getElementsByTagNameNS("*", local));
}

/** Attribute by local name, ignoring the prefix (r:id, r:embed, xlink:href...). */
export function attr(el: Element | null | undefined, local: string): string | undefined {
  if (!el) return undefined;
  const direct = el.getAttribute(local);
  if (direct !== null) return direct;
  for (const a of Array.from(el.attributes)) if (a.localName === local) return a.value;
  return undefined;
}

export function numAttr(el: Element | null | undefined, local: string): number | undefined {
  const v = attr(el, local);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
