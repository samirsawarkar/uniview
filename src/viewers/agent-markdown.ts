import React, { useMemo } from "react";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const MAX_BYTES = 256 * 1024; // 256 KiB = 262,144 bytes

const ALLOWED_TAGS = [
  "p",
  "br",
  "hr",
  "em",
  "strong",
  "del",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "span",
  "button",
];

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateToByteLimit(
  text: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.length <= maxBytes) {
    return { text, truncated: false };
  }

  let sliceEnd = maxBytes;
  while (sliceEnd > 0) {
    const byte = encoded[sliceEnd];
    if (byte !== undefined && (byte & 0xc0) === 0x80) {
      sliceEnd--;
    } else {
      break;
    }
  }

  const startByte = encoded[sliceEnd];
  if (startByte !== undefined && startByte >= 0xc0) {
    let needed = 2;
    if ((startByte & 0xf0) === 0xe0) needed = 3;
    else if ((startByte & 0xf8) === 0xf0) needed = 4;
    if (sliceEnd + needed <= maxBytes) {
      sliceEnd += needed;
    }
  }

  const decoder = new TextDecoder("utf-8");
  const truncatedText = decoder.decode(encoded.subarray(0, sliceEnd));
  return {
    text: truncatedText + "\n\n*(Content truncated: exceeds 256 KiB limit)*",
    truncated: true,
  };
}

const md = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
});

md.validateLink = (url: string): boolean => {
  const trimmed = url.trim();
  return /^(?:https?|mailto):/i.test(trimmed);
};

md.renderer.rules.link_open = () => {
  return '<span class="agent-link">';
};

md.renderer.rules.link_close = (tokens, idx) => {
  let href = "";
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const t = tokens[i];
    if (!t) continue;
    if (t.type === "link_close") {
      depth++;
    } else if (t.type === "link_open") {
      if (depth === 0) {
        href = String(t.attrGet("href") ?? "");
        break;
      }
      depth--;
    }
  }
  return ` <code class="agent-url">${escapeHtml(href)}</code> <button type="button" class="agent-copy" data-copy="${escapeHtml(href)}" aria-label="Copy link address">Copy</button></span>`;
};

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (!token) return "";
  const alt =
    token.content ||
    (token.children ? self.renderInlineAsText(token.children, options, env) : "");
  return `<span class="agent-image-removed">[image: ${escapeHtml(alt)}]</span>`;
};

md.renderer.rules.code_inline = (tokens, idx) => {
  const token = tokens[idx];
  return `<code>${escapeHtml(token?.content ?? "")}</code>`;
};

md.renderer.rules.code_block = (tokens, idx) => {
  const token = tokens[idx];
  return `<pre><code>${escapeHtml(token?.content ?? "")}</code></pre>\n`;
};

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const info = token?.info ? token.info.trim() : "";
  const lang = info ? (info.split(/\s+/)[0] ?? "") : "";
  const code = escapeHtml(token?.content ?? "");
  if (lang) {
    return `<pre><code class="language-${escapeHtml(lang)}">${code}</code></pre>\n`;
  }
  return `<pre><code>${code}</code></pre>\n`;
};

function renderTableCell(
  tokens: any[],
  idx: number,
  options: any,
  env: any,
  self: any
) {
  const token = tokens[idx];
  if (token) {
    const styleIdx = token.attrIndex ? token.attrIndex("style") : -1;
    if (styleIdx >= 0 && token.attrs) {
      const styleAttr = token.attrs[styleIdx];
      const styleVal = styleAttr ? styleAttr[1] : "";
      const match = /text-align:\s*(left|center|right)/i.exec(styleVal);
      if (match && match[1]) {
        token.attrs.splice(styleIdx, 1);
        const alignClass = `align-${match[1].toLowerCase()}`;
        const classIdx = token.attrIndex("class");
        const classAttr =
          classIdx >= 0 && token.attrs ? token.attrs[classIdx] : undefined;
        if (classAttr) {
          classAttr[1] += ` ${alignClass}`;
        } else {
          token.attrPush(["class", alignClass]);
        }
      }
    }
  }
  return self.renderToken(tokens, idx, options);
}

md.renderer.rules.th_open = renderTableCell;
md.renderer.rules.td_open = renderTableCell;

export function renderAgentMarkdown(text: string): string {
  const { text: processedText } = truncateToByteLimit(text, MAX_BYTES);
  let rawHtml = md.render(processedText);

  rawHtml = rawHtml.replace(
    /<(th|td)([^>]*)style="text-align:\s*(left|center|right);?"([^>]*)>/gi,
    (_match, tag, before, align, after) => {
      const cls = `align-${align.toLowerCase()}`;
      if (/class="/i.test(before + after)) {
        return `<${tag}${before}${after}>`.replace(
          /class="([^"]*)"/i,
          `class="$1 ${cls}"`
        );
      }
      return `<${tag}${before} class="${cls}"${after}>`;
    }
  );

  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["class", "align", "type", "aria-label", "data-copy"],
    ALLOW_DATA_ATTR: false,
  });
}

export function sanitizeLabel(text: string, max: number): string {
  let s = text.replace(/[\t\r\n]/g, " ");
  s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  s = s.replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
  s = s.replace(/\s+/g, " ").trim();

  if (max <= 0) return "";
  const codePoints = Array.from(s);
  if (codePoints.length > max) {
    return codePoints.slice(0, max - 1).join("") + "…";
  }
  return s;
}

export interface AgentMarkdownProps {
  text: string;
  className?: string;
}

export function AgentMarkdown({
  text,
  className,
}: AgentMarkdownProps): React.ReactElement {
  const html = useMemo(() => renderAgentMarkdown(text), [text]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement | null;
    const copyBtn = el?.closest?.(".agent-copy") as HTMLElement | null;
    const urlEl = el?.closest?.(".agent-url") as HTMLElement | null;
    const target = copyBtn ?? urlEl;
    if (!target) return;

    const url = copyBtn
      ? (copyBtn.getAttribute("data-copy") ?? "")
      : (urlEl?.textContent ?? "");

    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      navigator.clipboard.writeText(url).catch(() => {});
    }
    target.classList.add("copied");
    setTimeout(() => {
      target.classList.remove("copied");
    }, 1500);
  };

  const classes = ["agent-markdown", className].filter(Boolean).join(" ");

  return React.createElement("div", {
    className: classes,
    onClick: handleClick,
    dangerouslySetInnerHTML: { __html: html },
  });
}

export default AgentMarkdown;
