// Builders for small, valid test documents. Used by unit tests and scripts/make-fixtures.mjs.
import { zipSync, zlibSync, strToU8 } from "fflate";
import * as XLSX from "xlsx";

const NS_A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const NS_R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const NS_P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Encode a solid-colour RGB PNG. */
export function makePng(width, height, [r, g, b]) {
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) raw.set([r, g, b], row + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(strToU8(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw)), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}

/** A small red PNG used inside documents. */
export const PNG_2x2 = makePng(8, 8, [220, 38, 38]);

function rels(list) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
    .join("")}</Relationships>`;
}

function z(files) {
  const out = {};
  for (const [k, v] of Object.entries(files)) out[k] = typeof v === "string" ? strToU8(v) : v;
  return zipSync(out, { level: 6 });
}

export function makePptx() {
  const theme = `<?xml version="1.0" encoding="UTF-8"?><a:theme ${NS_A} name="T"><a:themeElements>
<a:clrScheme name="c"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1>
<a:accent2><a:srgbClr val="DC2626"/></a:accent2><a:accent3><a:srgbClr val="16A34A"/></a:accent3><a:accent4><a:srgbClr val="CA8A04"/></a:accent4>
<a:accent5><a:srgbClr val="9333EA"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="f"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme>
<a:fmtScheme name="s"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`;

  const ph = (type, idx, xfrm, extra = "") =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${idx + 2}" name="${type}"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"${idx !== undefined ? ` idx="${idx}"` : ""}/></p:nvPr></p:nvSpPr><p:spPr>${xfrm}</p:spPr>${extra}</p:sp>`;
  const xfrm = (x, y, w, h) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;

  const master = `<?xml version="1.0" encoding="UTF-8"?><p:sldMaster ${NS_A} ${NS_R} ${NS_P}><p:cSld>
<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${ph("title", undefined, xfrm(457200, 274638, 8229600, 1143000))}
${ph("body", 1, xfrm(457200, 1600200, 8229600, 4525963))}
<p:sp><p:nvSpPr><p:cNvPr id="9" name="Footer bar"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 6400800, 9144000, 457200)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="tx2"/></a:solidFill></p:spPr></p:sp>
</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4000" b="1"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>
<p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="•"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr><a:lvl2pPr marL="742950"><a:buChar char="–"/><a:defRPr sz="2400"/></a:lvl2pPr></p:bodyStyle>
<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

  const layout = `<?xml version="1.0" encoding="UTF-8"?><p:sldLayout ${NS_A} ${NS_R} ${NS_P} type="obj"><p:cSld name="Title and Content"><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${ph("title", undefined, xfrm(457200, 300000, 8229600, 1000000))}
${ph("body", 1, "")}
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

  const slide1 = `<?xml version="1.0" encoding="UTF-8"?><p:sld ${NS_A} ${NS_R} ${NS_P}><p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${ph("title", undefined, "", `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Quarterly Review</a:t></a:r></a:p></p:txBody>`)}
<p:sp><p:nvSpPr><p:cNvPr id="4" name="Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(914400, 1828800, 2743200, 914400)}<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent2"><a:lumMod val="75000"/></a:schemeClr></a:solidFill></p:spPr>
<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="2000" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>Revenue up 12%</a:t></a:r></a:p></p:txBody></p:sp>
<p:pic><p:nvPicPr><p:cNvPr id="5" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(6400800, 1828800, 914400, 914400)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="914400" y="3200400"/><a:ext cx="5486400" cy="740000"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid><a:gridCol w="2743200"/><a:gridCol w="2743200"/></a:tblGrid>
<a:tr h="370000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Region</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Sales</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr>
<a:tr h="370000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>North</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>1,204</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr>
</a:tbl></a:graphicData></a:graphic></p:graphicFrame>
<p:grpSp><p:nvGrpSpPr><p:cNvPr id="7" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="6400800" y="3200400"/><a:ext cx="1828800" cy="914400"/><a:chOff x="0" y="0"/><a:chExt cx="3657600" cy="1828800"/></a:xfrm></p:grpSpPr>
<p:sp><p:nvSpPr><p:cNvPr id="8" name="Child"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 0, 3657600, 1828800)}<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent3"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>
<p:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:t>Grouped</a:t></a:r></a:p></p:txBody></p:sp></p:grpSp>
</p:spTree></p:cSld></p:sld>`;

  const slide2 = `<?xml version="1.0" encoding="UTF-8"?><p:sld ${NS_A} ${NS_R} ${NS_P}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FEF3C7"/></a:solidFill></p:bgPr></p:bg><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${ph("title", undefined, "", `<p:txBody><a:bodyPr/><a:p><a:r><a:t>Next Steps</a:t></a:r></a:p></p:txBody>`)}
${ph("body", 1, "", `<p:txBody><a:bodyPr><a:normAutofit fontScale="90000"/></a:bodyPr><a:p><a:r><a:t>Hire two engineers</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>Backend first</a:t></a:r></a:p><a:p><a:r><a:t>Ship V1</a:t></a:r></a:p></p:txBody>`)}
${ph("dt", 10, "")}
</p:spTree></p:cSld></p:sld>`;

  const notes = `<?xml version="1.0" encoding="UTF-8"?><p:notes ${NS_A} ${NS_R} ${NS_P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${ph("body", 1, "", `<p:txBody><a:bodyPr/><a:p><a:r><a:t>Mention the new hires.</a:t></a:r></a:p></p:txBody>`)}</p:spTree></p:cSld></p:notes>`;

  const pres = `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${NS_A} ${NS_R} ${NS_P}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;

  return z({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
    "_rels/.rels": rels([["rId1", "officeDocument", "ppt/presentation.xml"]]),
    "ppt/presentation.xml": pres,
    "ppt/_rels/presentation.xml.rels": rels([["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ["rId2", "slide", "slides/slide1.xml"], ["rId3", "slide", "slides/slide2.xml"]]),
    "ppt/slideMasters/slideMaster1.xml": master,
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "theme", "../theme/theme1.xml"]]),
    "ppt/slideLayouts/slideLayout1.xml": layout,
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
    "ppt/theme/theme1.xml": theme,
    "ppt/slides/slide1.xml": slide1,
    "ppt/slides/_rels/slide1.xml.rels": rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "image", "../media/image1.png"], ["rId3", "notesSlide", "../notesSlides/notesSlide1.xml"]]),
    "ppt/slides/slide2.xml": slide2,
    "ppt/slides/_rels/slide2.xml.rels": rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]),
    "ppt/notesSlides/notesSlide1.xml": notes,
    "ppt/media/image1.png": PNG_2x2,
    "docProps/thumbnail.png": PNG_2x2,
  });
}

export function makeDocx() {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Project Charter</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">UniView opens </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>every</w:t></w:r><w:r><w:t xml:space="preserve"> file offline.</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Samir</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  return z({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": rels([["rId1", "officeDocument", "word/document.xml"]]),
    "word/document.xml": doc,
  });
}

export function makeEpub() {
  const chapter = (title, body) => `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><link rel="stylesheet" href="../style.css"/></head><body><h1>${title}</h1>${body}<script>window.hacked = true;</script></body></html>`;
  return zipSync(
    {
      mimetype: [strToU8("application/epub+zip"), { level: 0 }],
      "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
      "OEBPS/content.opf": strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Test Book</dc:title><dc:creator>A. Author</dc:creator><dc:identifier id="id">urn:uuid:1</dc:identifier></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/><item id="css" href="style.css" media-type="text/css"/><item id="img" href="images/dot.png" media-type="image/png"/></manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`),
      "OEBPS/nav.xhtml": strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">Chapter One</a></li><li><a href="text/ch2.xhtml">Chapter Two</a></li></ol></nav></body></html>`),
      "OEBPS/text/ch1.xhtml": strToU8(chapter("Chapter One", `<p>It was a bright cold day.</p><img src="../images/dot.png" alt="dot"/>`)),
      "OEBPS/text/ch2.xhtml": strToU8(chapter("Chapter Two", `<p>The end.</p>`)),
      "OEBPS/style.css": strToU8("h1 { color: rgb(180, 0, 0); }"),
      "OEBPS/images/dot.png": PNG_2x2,
    },
    { level: 6 },
  );
}

/** A minimal one-page PDF with a line of text, with a correct xref table. */
export function makePdf(text = "Hello from UniView") {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(out);
}

export function makeHardPptx() {
  const theme = `<?xml version="1.0" encoding="UTF-8"?><a:theme ${NS_A} name="T"><a:themeElements>
<a:clrScheme name="c"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1>
<a:accent2><a:srgbClr val="DC2626"/></a:accent2><a:accent3><a:srgbClr val="16A34A"/></a:accent3><a:accent4><a:srgbClr val="CA8A04"/></a:accent4>
<a:accent5><a:srgbClr val="9333EA"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="f"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme>
<a:fmtScheme name="s"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`;

  const xfrm = (x, y, w, h, extra = "") => `<a:xfrm${extra}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;
  const ph = (type, idx, xfrmStr, extra = "") =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${idx !== undefined ? idx + 2 : 2}" name="${type}"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"${idx !== undefined ? ` idx="${idx}"` : ""}/></p:nvPr></p:nvSpPr><p:spPr>${xfrmStr}</p:spPr>${extra}</p:sp>`;

  const master = `<?xml version="1.0" encoding="UTF-8"?><p:sldMaster ${NS_A} ${NS_R} ${NS_P}><p:cSld>
<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${ph("title", undefined, xfrm(457200, 274638, 8229600, 1143000))}
${ph("body", 1, xfrm(457200, 1600200, 8229600, 4525963))}
</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4000" b="1"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>
<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle>
<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

  const layout = `<?xml version="1.0" encoding="UTF-8"?><p:sldLayout ${NS_A} ${NS_R} ${NS_P} type="obj"><p:cSld name="Title and Content"><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${ph("title", undefined, xfrm(457200, 300000, 8229600, 1000000))}
${ph("body", 1, "")}
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

  const slide1 = `<?xml version="1.0" encoding="UTF-8"?><p:sld ${NS_A} ${NS_R} ${NS_P}><p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(457200, 200000, 8229600, 600000)}</p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Hard Deck</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Rotated"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(914400, 914400, 1828800, 914400, ' rot="2700000"')}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="3B82F6"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Rotated 45</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="4" name="Arrow"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(3657600, 914400, 1828800, 914400, ' flipH="1"')}<a:prstGeom prst="rightArrow"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="10B981"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Flipped Arrow</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="5" name="Grad"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(914400, 2286000, 1828800, 914400)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="EF4444"/></a:gs><a:gs pos="100000"><a:srgbClr val="3B82F6"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Gradient Shape</a:t></a:r></a:p></p:txBody></p:sp>
<p:pic><p:nvPicPr><p:cNvPr id="6" name="CroppedImg"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:srcRect l="10000" t="20000" r="10000" b="20000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(3657600, 2286000, 1828800, 1828800)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
<p:sp><p:nvSpPr><p:cNvPr id="7" name="LinkText"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(914400, 3657600, 3657600, 914400)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr><a:hlinkClick r:id="rIdHlink"/></a:rPr><a:t>UniView Docs</a:t></a:r><a:r><a:rPr baseline="30000"/><a:t>[1]</a:t></a:r></a:p></p:txBody></p:sp>
<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="MergedTable"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="914400" y="4754880"/><a:ext cx="5486400" cy="914400"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1828800"/><a:gridCol w="1828800"/><a:gridCol w="1828800"/></a:tblGrid>
<a:tr h="457200"><a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:t>Merged Header</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc><a:tc hMerge="1"><a:txBody><a:bodyPr/><a:p/></a:txBody><a:tcPr/></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Col 3</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr>
<a:tr h="457200"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Cell A</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Cell B</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Cell C</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr>
</a:tbl></a:graphicData></a:graphic></p:graphicFrame>
<p:grpSp><p:nvGrpSpPr><p:cNvPr id="50" name="OuterGroup"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="6400800" y="914400"/><a:ext cx="2540000" cy="2540000"/><a:chOff x="0" y="0"/><a:chExt cx="5080000" cy="5080000"/></a:xfrm></p:grpSpPr>
<p:grpSp><p:nvGrpSpPr><p:cNvPr id="51" name="InnerGroup"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="2540000"/><a:chOff x="0" y="0"/><a:chExt cx="2540000" cy="2540000"/></a:xfrm></p:grpSpPr>
<p:sp><p:nvSpPr><p:cNvPr id="52" name="DeepChild"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(635000, 635000, 1270000, 1270000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="8B5CF6"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Deep Child</a:t></a:r></a:p></p:txBody></p:sp>
</p:grpSp></p:grpSp>
<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="60" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="6400800" y="3657600"/><a:ext cx="2540000" cy="1828800"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdChart"/></a:graphicData></a:graphic></p:graphicFrame>
</p:spTree></p:cSld></p:sld>`;

  const slide2 = `<?xml version="1.0" encoding="UTF-8"?><p:sld ${NS_A} ${NS_R} ${NS_P} show="0"><p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(914400, 914400, 7315200, 914400)}</p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Hidden Slide Content</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;

  const slide3 = `<?xml version="1.0" encoding="UTF-8"?><p:sld ${NS_A} ${NS_R} ${NS_P}><p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(914400, 914400, 7315200, 914400)}</p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Conclusion</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;

  const pres = `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${NS_A} ${NS_R} ${NS_P}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;

  return z({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
    "_rels/.rels": rels([["rId1", "officeDocument", "ppt/presentation.xml"]]),
    "ppt/presentation.xml": pres,
    "ppt/_rels/presentation.xml.rels": rels([["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ["rId2", "slide", "slides/slide1.xml"], ["rId3", "slide", "slides/slide2.xml"], ["rId4", "slide", "slides/slide3.xml"]]),
    "ppt/slideMasters/slideMaster1.xml": master,
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "theme", "../theme/theme1.xml"]]),
    "ppt/slideLayouts/slideLayout1.xml": layout,
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
    "ppt/theme/theme1.xml": theme,
    "ppt/slides/slide1.xml": slide1,
    "ppt/slides/_rels/slide1.xml.rels": rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "image", "../media/image1.png"], ["rIdHlink", "hyperlink", "https://uniview.app"]]),
    "ppt/slides/slide2.xml": slide2,
    "ppt/slides/_rels/slide2.xml.rels": rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]),
    "ppt/slides/slide3.xml": slide3,
    "ppt/slides/_rels/slide3.xml.rels": rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]),
    "ppt/media/image1.png": PNG_2x2,
    "docProps/thumbnail.png": PNG_2x2,
  });
}

export function makeHardDocx() {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Hard Document Title</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Second item</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Third item</w:t></w:r></w:p>
  <w:p><w:hyperlink r:id="rIdHlink"><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t>UniView Project</w:t></w:r></w:hyperlink></w:p>
  <w:tbl>
    <w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr>
    <w:tr>
      <w:tc><w:p><w:r><w:t>R1C1</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>R1C2</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>R1C3</w:t></w:r></w:p></w:tc>
    </w:tr>
    <w:tr>
      <w:tc><w:p><w:r><w:t>R2C1</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>R2C2</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>R2C3</w:t></w:r></w:p></w:tc>
    </w:tr>
    <w:tr>
      <w:tc><w:p><w:r><w:t>R3C1</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>R3C2</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>R3C3</w:t></w:r></w:p></w:tc>
    </w:tr>
  </w:tbl>
  <w:p>
    <w:r>
      <w:drawing>
        <wp:inline distT="0" distB="0" distL="0" distR="0">
          <wp:extent cx="1828800" cy="1828800"/>
          <wp:docPr id="1" name="Picture 1"/>
          <a:graphic>
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:pic>
                <pic:nvPicPr><pic:cNvPr id="0" name="image.png"/><pic:cNvPicPr/></pic:nvPicPr>
                <pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
                <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
              </pic:pic>
            </a:graphicData>
          </a:graphic>
        </wp:inline>
      </w:drawing>
    </w:r>
  </w:p>
  <w:sectPr>
    <w:headerReference w:type="default" r:id="rIdHdr"/>
    <w:footerReference w:type="default" r:id="rIdFtr"/>
    <w:pgSz w:w="12240" w:h="15840"/>
    <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
  </w:sectPr>
</w:body></w:document>`;

  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Confidential Header</w:t></w:r></w:p></w:hdr>`;
  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Confidential Footer</w:t></w:r></w:p></w:ftr>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

  return z({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
    "_rels/.rels": rels([["rId1", "officeDocument", "word/document.xml"]]),
    "word/document.xml": doc,
    "word/_rels/document.xml.rels": rels([
      ["rIdHdr", "header", "header1.xml"],
      ["rIdFtr", "footer", "footer1.xml"],
      ["rIdNum", "numbering", "numbering.xml"],
      ["rIdImg", "image", "media/image1.png"],
      ["rIdHlink", "hyperlink", "https://uniview.app"],
    ]),
    "word/header1.xml": header,
    "word/footer1.xml": footer,
    "word/numbering.xml": numbering,
    "word/media/image1.png": PNG_2x2,
  });
}

export function makeHardXlsx() {
  const wb = XLSX.utils.book_new();

  const ws1Data = [
    ["Quarterly Revenue Summary", "", ""],
    ["Metric", "Value", "Notes"],
    ["Report Date", new Date(2026, 9, 23), "Audited"],
    ["Growth Rate", 0.175, "Target met"],
    ["Budget", 1500000, "Q4 allocation"],
    ["Total", 1500000.175, "Computed"],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(ws1Data, { cellDates: true });
  if (ws1["B3"]) ws1["B3"].z = "yyyy-mm-dd";
  if (ws1["B4"]) { ws1["B4"].t = "n"; ws1["B4"].z = "0.0%"; ws1["B4"].w = "17.5%"; }
  if (ws1["B5"]) { ws1["B5"].t = "n"; ws1["B5"].z = "$#,##0.00"; ws1["B5"].w = "$1,500,000.00"; }
  if (ws1["B6"]) { ws1["B6"].t = "n"; ws1["B6"].f = "SUM(B4:B5)"; ws1["B6"].v = 1500000.175; ws1["B6"].w = "1,500,000.18"; }

  ws1["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];
  ws1["!cols"] = [{ wch: 25 }, { wch: 20 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, ws1, "Summary");

  const wideHead = [];
  const wideRow = [];
  for (let c = 1; c <= 200; c++) {
    wideHead.push(`Col ${c}`);
    wideRow.push(c * 10);
  }
  const ws2 = XLSX.utils.aoa_to_sheet([wideHead, wideRow]);
  XLSX.utils.book_append_sheet(wb, ws2, "Wide");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

export function makeZip() {
  return z({ "readme.txt": "Inside the archive.", "data/report.md": "# Nested report\n\nHello.", "data/pixel.png": PNG_2x2 });
}
