import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { FormatKind } from "../core/types";
import type { ViewerProps } from "./types";

type Lazy = LazyExoticComponent<ComponentType<ViewerProps>>;

// Each viewer is its own chunk, so startup loads none of pdf.js, SheetJS or highlight.js.
const pdf = lazy(() => import("./PdfViewer"));
const image = lazy(() => import("./ImageViewer"));
const tiff = lazy(() => import("./TiffViewer"));
const media = lazy(() => import("./MediaViewer"));
const docx = lazy(() => import("./DocxViewer"));
const sheet = lazy(() => import("./SheetViewer"));
const pptx = lazy(() => import("./PptxViewer"));
const epub = lazy(() => import("./EpubViewer"));
const zip = lazy(() => import("./ZipViewer"));
const markdown = lazy(() => import("./MarkdownViewer"));
const json = lazy(() => import("./JsonViewer"));
const viewspec = lazy(() => import("./ViewSpecViewer"));
const receipt = lazy(() => import("./ReceiptViewer"));
const text = lazy(() => import("./TextViewer"));
const font = lazy(() => import("./FontViewer"));
const legacy = lazy(() => import("./LegacyOfficeViewer"));
export const HexViewer = lazy(() => import("./HexViewer"));
export const TextViewer = text;

export const VIEWERS: Record<FormatKind, Lazy> = {
  pdf, image, tiff, video: media, audio: media, docx, sheet, pptx, epub, zip, markdown, json, viewspec, receipt, text, font,
  "legacy-office": legacy, binary: HexViewer,
};

/** Warm the chunk for a kind so the first open of that type is faster. */
export function preload(kind: FormatKind): void {
  const loaders: Partial<Record<FormatKind, () => Promise<unknown>>> = {
    pdf: () => import("./PdfViewer"), docx: () => import("./DocxViewer"), sheet: () => import("./SheetViewer"),
    pptx: () => import("./PptxViewer"), text: () => import("./TextViewer"), image: () => import("./ImageViewer"),
  };
  void loaders[kind]?.().catch(() => {});
}
