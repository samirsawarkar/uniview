import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parsePptx, type PlaceholderEl } from "../../src/core/pptx";
import { zipSync, strToU8 } from "fflate";

const BANNED_PATTERNS = [
  /@aiden0z\/pptx-renderer/,
  /pptx-renderer/,
  /mtx-decompressor/,
];

function collectFiles(dir: string, extensions: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      return collectFiles(full, extensions);
    }
    return extensions.test(name) ? [full] : [];
  });
}

function makePresentationWithEquation(): Uint8Array {
  const rels = (list: [string, string, string][]) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
      .map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`)
      .join("")}</Relationships>`;

  const NS_A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const NS_R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const NS_P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

  const sld = `<?xml version="1.0" encoding="UTF-8"?><p:sld ${NS_A} ${NS_R} ${NS_P}><p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:graphicFrame>
  <p:nvGraphicFramePr><p:cNvPr id="10" name="Equation 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
  <p:xfrm><a:off x="914400" y="914400"/><a:ext cx="2540000" cy="1270000"/></p:xfrm>
  <a:graphic>
    <a:graphicData uri="http://schemas.openxmlformats.org/officeDocument/2006/math">
      <m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>E = mc^2</m:t></m:r></m:oMath>
    </a:graphicData>
  </a:graphic>
</p:graphicFrame>
<p:graphicFrame>
  <p:nvGraphicFramePr><p:cNvPr id="11" name="MathType Equation"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
  <p:xfrm><a:off x="914400" y="2540000"/><a:ext cx="2540000" cy="1270000"/></p:xfrm>
  <a:graphic>
    <a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole">
      <p:oleObj progId="Equation.DSMT4" r:id="rIdOle"/>
    </a:graphicData>
  </a:graphic>
</p:graphicFrame>
</p:spTree></p:cSld></p:sld>`;

  const pres = `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${NS_A} ${NS_R} ${NS_P}>
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>
<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;

  const out: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`),
    "_rels/.rels": strToU8(rels([["rId1", "officeDocument", "ppt/presentation.xml"]])),
    "ppt/presentation.xml": strToU8(pres),
    "ppt/_rels/presentation.xml.rels": strToU8(rels([["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ["rId2", "slide", "slides/slide1.xml"]])),
    "ppt/slideMasters/slideMaster1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><p:sldMaster ${NS_A} ${NS_R} ${NS_P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": strToU8(rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]])),
    "ppt/slideLayouts/slideLayout1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><p:sldLayout ${NS_A} ${NS_R} ${NS_P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldLayout>`),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]])),
    "ppt/slides/slide1.xml": strToU8(sld),
    "ppt/slides/_rels/slide1.xml.rels": strToU8(rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]])),
  };
  return zipSync(out, { level: 6 });
}

describe("P19 MPL-2.0 PowerPoint Engine Exclusion & Fallback", () => {
  it("package.json contains no pptx-renderer or mtx-decompressor dependencies", () => {
    const pkgText = readFileSync("package.json", "utf8");
    const pkg = JSON.parse(pkgText);
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    };
    for (const banned of ["@aiden0z/pptx-renderer", "pptx-renderer", "mtx-decompressor"]) {
      expect(allDeps[banned], `Found banned dependency ${banned} in package.json`).toBeUndefined();
    }
    for (const pattern of BANNED_PATTERNS) {
      expect(pattern.test(pkgText), `package.json text matches banned pattern ${pattern}`).toBe(false);
    }
  });

  it("package-lock.json contains no pptx-renderer or mtx-decompressor entries", () => {
    if (existsSync("package-lock.json")) {
      const lockText = readFileSync("package-lock.json", "utf8");
      for (const pattern of BANNED_PATTERNS) {
        expect(pattern.test(lockText), `package-lock.json matches banned pattern ${pattern}`).toBe(false);
      }
    }
  });

  it("src and electron contain no imports or references to pptx-renderer or mtx-decompressor", () => {
    const codeFiles = [
      ...collectFiles("src", /\.(ts|tsx|js|mjs)$/),
      ...collectFiles("electron", /\.(ts|tsx|js|mjs)$/),
    ];
    expect(codeFiles.length).toBeGreaterThan(0);

    const violations: { file: string; pattern: string }[] = [];
    for (const file of codeFiles) {
      const content = readFileSync(file, "utf8");
      for (const pattern of BANNED_PATTERNS) {
        if (pattern.test(content)) {
          violations.push({ file, pattern: pattern.toString() });
        }
      }
    }
    expect(violations, `Found banned MPL packages in code files`).toEqual([]);
  });

  it("THIRD_PARTY_NOTICES.md states secondary PowerPoint engine is deferred to V1.1 as an isolated chunk", () => {
    const notices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
    expect(notices).toMatch(/deferred to V1\.1 as an isolated chunk/i);
    expect(notices).not.toMatch(/awaiting a separate licence-policy decision/i);
    // Must not list any MPL-2.0 as bundled
    const bundledTableMatch = notices.slice(0, notices.indexOf("Development-only tools"));
    expect(bundledTableMatch).not.toMatch(/MPL-2\.0\s*\|/);
  });

  it("Documentation (README, docs/SPEC.md, docs/STATUS.md) states PowerPoint engine is deferred to V1.1 as an isolated chunk", () => {
    const readme = readFileSync("README.md", "utf8");
    const spec = readFileSync("docs/SPEC.md", "utf8");
    const status = readFileSync("docs/STATUS.md", "utf8");

    expect(readme).toMatch(/deferred to V1\.1 as an isolated chunk/i);
    expect(spec).toMatch(/deferred to V1\.1 as an isolated chunk/i);
    expect(status).toMatch(/deferred to V1\.1 as an isolated chunk/i);
    expect(status).not.toMatch(/Open: the optional PowerPoint engine uses an MPL-2\.0 component/i);
  });

  it("falls back gracefully for equations and MathType OLE without crashing", () => {
    const deck = makePresentationWithEquation();
    expect(() => parsePptx(deck)).not.toThrow();

    const pres = parsePptx(deck);
    expect(pres.slides).toHaveLength(1);
    const slide = pres.slides[0]!;

    const placeholders = slide.elements.filter((e): e is PlaceholderEl => e.type === "placeholder");
    expect(placeholders.length).toBeGreaterThanOrEqual(2);

    const eqPlaceholders = placeholders.filter((p) => p.label === "Equation");
    expect(eqPlaceholders.length).toBe(2);
  });
});
