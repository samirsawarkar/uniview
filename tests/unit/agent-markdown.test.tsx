import { describe, it, expect, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Minimal stand-in for @testing-library/react's render, using React's own act. */
function render(ui: ReactElement): { container: HTMLDivElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(ui);
  });
  return { container };
}

const fireEvent = {
  click(el: Element): void {
    act(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  },
};

import {
  renderAgentMarkdown,
  sanitizeLabel,
  AgentMarkdown,
} from "../../src/viewers/agent-markdown";

describe("agent-markdown", () => {
  it("renders links without <a> tags and shows URLs as text", () => {
    const markdown = [
      "[x](https://evil.example)",
      "<https://x>",
      "[x][ref]",
      "",
      "[ref]: https://evil.example",
    ].join("\n\n");

    const html = renderAgentMarkdown(markdown);
    const container = document.createElement("div");
    container.innerHTML = html;

    expect(container.querySelectorAll("a").length).toBe(0);

    const urls = Array.from(container.querySelectorAll(".agent-url")).map(
      (el) => el.textContent
    );
    expect(urls).toContain("https://evil.example");
    expect(urls).toContain("https://x");

    expect(container.querySelectorAll(".agent-link").length).toBe(3);
  });

  // Mutation caught: allowing javascript:, file:, data:, vbscript:, or relative URLs as links in md.validateLink
  it("only recognizes http(s) and mailto links, keeping other schemes and relative URLs as literal text", () => {
    const markdown = [
      "[web](http://example.com)",
      "[secure](https://example.com/path)",
      "[mail](mailto:test@example.com)",
      "[caps http](HTTP://EXAMPLE.ORG)",
      "[caps mail](MAILTO:USER@EXAMPLE.ORG)",
      "<http://autolink.example.com>",
      "<https://autolink.example.com>",
      "<mailto:auto@example.com>",
      "[js](javascript:alert(1))",
      "[file](file:///C:/secret)",
      "[data](data:text/html,<b>xss</b>)",
      "[vbs](vbscript:msgbox(1))",
      "[rel1](/root/relative)",
      "[rel2](relative/path)",
      "<file:///C:/x>",
      "<javascript:alert(1)>",
      "<data:text/html,test>",
    ].join("\n\n");

    const html = renderAgentMarkdown(markdown);
    const container = document.createElement("div");
    container.innerHTML = html;

    expect(container.querySelectorAll("a").length).toBe(0);

    const links = Array.from(container.querySelectorAll(".agent-link"));
    expect(links.length).toBe(8);

    const urls = Array.from(container.querySelectorAll(".agent-url")).map(
      (el) => el.textContent
    );
    expect(urls).toEqual([
      "http://example.com",
      "https://example.com/path",
      "mailto:test@example.com",
      "HTTP://EXAMPLE.ORG",
      "MAILTO:USER@EXAMPLE.ORG",
      "http://autolink.example.com",
      "https://autolink.example.com",
      "mailto:auto@example.com",
    ]);

    expect(container.textContent).toContain("[js](javascript:alert(1))");
    expect(container.textContent).toContain("[file](file:///C:/secret)");
    expect(container.textContent).toContain("[data](data:text/html,<b>xss</b>)");
    expect(container.textContent).toContain("[vbs](vbscript:msgbox(1))");
    expect(container.textContent).toContain("[rel1](/root/relative)");
    expect(container.textContent).toContain("[rel2](relative/path)");
    expect(container.textContent).toContain("<file:///C:/x>");
    expect(container.textContent).toContain("<javascript:alert(1)>");
    expect(container.textContent).toContain("<data:text/html,test>");
  });

  // Mutation caught: missing .agent-copy button, wrong attributes, not focusable, or clicking button does not invoke navigator.clipboard.writeText
  it("renders copy button with URL in data-copy, is focusable, and copies on click", () => {
    vi.useFakeTimers();

    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    const { container } = render(
      <AgentMarkdown text="Reference [doc](https://specs.example.com/p13b)" />
    );

    const linkEl = container.querySelector(".agent-link");
    expect(linkEl).not.toBeNull();

    const copyBtn = container.querySelector(
      "button.agent-copy"
    ) as HTMLButtonElement | null;
    expect(copyBtn).not.toBeNull();
    expect(copyBtn?.getAttribute("type")).toBe("button");
    expect(copyBtn?.getAttribute("data-copy")).toBe(
      "https://specs.example.com/p13b"
    );
    expect(copyBtn?.getAttribute("aria-label")).toBe("Copy link address");
    expect(copyBtn?.textContent).toBe("Copy");

    expect(copyBtn?.tabIndex).toBe(0);
    copyBtn?.focus();
    expect(document.activeElement).toBe(copyBtn);

    fireEvent.click(copyBtn!);
    expect(writeTextMock).toHaveBeenCalledWith(
      "https://specs.example.com/p13b"
    );
    expect(copyBtn?.classList.contains("copied")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(copyBtn?.classList.contains("copied")).toBe(false);

    const urlEl = container.querySelector(".agent-url");
    expect(urlEl).not.toBeNull();
    writeTextMock.mockClear();

    fireEvent.click(urlEl!);
    expect(writeTextMock).toHaveBeenCalledWith(
      "https://specs.example.com/p13b"
    );
    expect(urlEl?.classList.contains("copied")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(urlEl?.classList.contains("copied")).toBe(false);

    vi.useRealTimers();
  });

  it("renders images as removed text placeholders without <img> tags", () => {
    const markdown = [
      "![a](https://x/y.png)",
      "![a](data:image/png;base64,AA==)",
    ].join("\n\n");

    const html = renderAgentMarkdown(markdown);
    const container = document.createElement("div");
    container.innerHTML = html;

    expect(container.querySelectorAll("img").length).toBe(0);
    const removed = Array.from(
      container.querySelectorAll(".agent-image-removed")
    ).map((el) => el.textContent);
    expect(removed).toEqual(["[image: a]"]);
    // A data: image is not a recognized link target, so it stays literal text.
    expect(container.textContent).toContain("![a](data:image/png;base64,AA==)");
  });

  it("escapes raw HTML as text and creates no corresponding elements", () => {
    const markdown = [
      "<b>hi</b>",
      "<img src=x onerror=alert(1)>",
      "<script>alert('pwn')</script>",
    ].join("\n\n");

    const html = renderAgentMarkdown(markdown);
    const container = document.createElement("div");
    container.innerHTML = html;

    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();

    expect(container.textContent).toContain("<b>hi</b>");
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain("<script>alert('pwn')</script>");
  });

  it("renders tables, lists, code, blockquote, and headings properly", () => {
    const markdown = [
      "# Heading 1",
      "## Heading 2",
      "> Blockquote text",
      "- item 1",
      "- item 2",
      "1. first",
      "2. second",
      "Inline `inline_code` here",
      "```js",
      "const val = 42;",
      "```",
      ["| Left | Center | Right |", "| :--- | :---: | ---: |", "| L1   | C1     | R1    |"].join("\n"),
    ].join("\n\n");

    const html = renderAgentMarkdown(markdown);
    const container = document.createElement("div");
    container.innerHTML = html;

    expect(container.querySelector("h1")?.textContent).toBe("Heading 1");
    expect(container.querySelector("h2")?.textContent).toBe("Heading 2");
    expect(container.querySelector("blockquote")?.textContent?.trim()).toBe(
      "Blockquote text"
    );
    expect(container.querySelector("ul")).not.toBeNull();
    expect(container.querySelector("ol")).not.toBeNull();
    expect(container.querySelectorAll("li").length).toBe(4);
    expect(container.querySelector("code")).not.toBeNull();
    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("thead")).not.toBeNull();
    expect(container.querySelector("tbody")).not.toBeNull();
    expect(container.querySelector("th.align-left")).not.toBeNull();
    expect(container.querySelector("th.align-center")).not.toBeNull();
    expect(container.querySelector("th.align-right")).not.toBeNull();
    expect(container.querySelector("td.align-left")).not.toBeNull();
    expect(container.querySelector("td.align-center")).not.toBeNull();
    expect(container.querySelector("td.align-right")).not.toBeNull();
  });

  // Mutation caught: creating Image instances, setting HTMLImageElement.src, or initiating network requests during rendering
  it("creates no network activity or forbidden elements when rendering large documents", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, "open");
    const imageSpy = vi.spyOn(globalThis, "Image");
    const srcSetterSpy = vi.spyOn(HTMLImageElement.prototype, "src", "set");

    const createdForbiddenTags: string[] = [];
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tagName: string, options?: any) => {
        const lower = tagName.toLowerCase();
        if (["img", "script", "iframe", "link"].includes(lower)) {
          createdForbiddenTags.push(lower);
        }
        return originalCreateElement(tagName, options);
      });

    try {
      const largeDoc = [
        "# Security Analysis Report",
        "## Subheading level 2",
        "### Subheading level 3",
        "#### Subheading level 4",
        "##### Subheading level 5",
        "###### Subheading level 6",
        "Executive summary with *italics*, **bold**, ~~strikethrough~~, and `code`.",
        "---",
        "> Important policy quote",
        "- Bullet point 1",
        "- Bullet point 2",
        "1. Numbered point 1",
        "2. Numbered point 2",
        "![Remote Banner](https://evil.example.com/banner.jpg)",
        "![Data URI](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==)",
        "<script src='https://evil.example.com/payload.js'></script>",
        "<script>alert('pwn')</script>",
        "<iframe src='https://evil.example.com/embed'></iframe>",
        "<link rel='stylesheet' href='https://evil.example.com/style.css'>",
        "<img src='https://evil.example.com/tracker.gif' onerror='alert(1)'>",
        "[Allowed Web Link](https://evil.example.com/phish)",
        "[Allowed Mailto](mailto:support@example.com)",
        "<https://evil.example.com/autolink>",
        "<mailto:auto@example.com>",
        "[Forbidden JS](javascript:alert(1))",
        "[Forbidden File](file:///C:/secret)",
        "[Forbidden Data](data:text/html,<script>alert(1)</script>)",
        "[Forbidden VBS](vbscript:msgbox(1))",
        "[Forbidden Rel](/relative/delete)",
        "<file:///C:/x>",
        "<javascript:alert(1)>",
        "| Col 1 | Col 2 | Col 3 |",
        "| :--- | :---: | ---: |",
        "| Data 1 | Data 2 | Data 3 |",
        "```python",
        "import requests\nrequests.get('https://example.com')",
        "```",
        "    const indented = true;",
      ]
        .concat(
          Array.from(
            { length: 100 },
            (_, i) => `Paragraph ${i}: [link ${i}](https://example.com/${i})`
          )
        )
        .join("\n\n");

      const html = renderAgentMarkdown(largeDoc);
      const container = document.createElement("div");
      container.innerHTML = html;

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(xhrSpy).not.toHaveBeenCalled();
      expect(imageSpy).not.toHaveBeenCalled();
      expect(srcSetterSpy).not.toHaveBeenCalled();
      expect(createdForbiddenTags).toEqual([]);
      expect(container.querySelectorAll("img").length).toBe(0);
      expect(container.querySelectorAll("script").length).toBe(0);
      expect(container.querySelectorAll("iframe").length).toBe(0);
      expect(container.querySelectorAll("link").length).toBe(0);
    } finally {
      fetchSpy.mockRestore();
      xhrSpy.mockRestore();
      imageSpy.mockRestore();
      srcSetterSpy.mockRestore();
      createElementSpy.mockRestore();
    }
  });

  // Mutation caught: slicing max characters instead of max - 1 when truncating (resulting in max + 1 code points) or not returning "" for max <= 0
  it("sanitizeLabel strips control, bidi, zero-width chars and never returns more than max code points", () => {
    expect(sanitizeLabel("hello\tworld\nfrom\r\nagent", 50)).toBe(
      "hello world from agent"
    );

    expect(sanitizeLabel("a\u0000b\u0007c\u001Bd\u007Fe", 50)).toBe("abcde");

    expect(sanitizeLabel("a\u0080b\u0085c\u009Fd", 50)).toBe("abcd");

    const bidiChars =
      "\u061C\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069";
    expect(sanitizeLabel(`safe${bidiChars}text`, 50)).toBe("safetext");

    const zwChars = "\u200B\u200C\u200D\uFEFF";
    expect(sanitizeLabel(`zero${zwChars}width`, 50)).toBe("zerowidth");

    expect(sanitizeLabel("   lots    of    spaces   ", 50)).toBe(
      "lots of spaces"
    );

    expect(sanitizeLabel("1234567890", 5)).toBe("1234…");
    expect(sanitizeLabel("123456", 5)).toBe("1234…");
    expect(sanitizeLabel("12345", 5)).toBe("12345");
    expect(sanitizeLabel("123", 5)).toBe("123");

    expect(sanitizeLabel("🦊🐶🐱🐰🐻🐼", 3)).toBe("🦊🐶…");

    expect(sanitizeLabel("hello world", 0)).toBe("");
    expect(sanitizeLabel("hello world", -1)).toBe("");
    expect(sanitizeLabel("", 5)).toBe("");
  });

  it("truncates input longer than 256 KiB with a visible note", () => {
    const hugeText = "Hello world! ".repeat(25000);
    expect(new TextEncoder().encode(hugeText).length).toBeGreaterThan(
      256 * 1024
    );

    const html = renderAgentMarkdown(hugeText);
    expect(html).toContain("truncated");
    expect(html).toContain("256 KiB");

    const normalText = "Short markdown text";
    const normalHtml = renderAgentMarkdown(normalText);
    expect(normalHtml).not.toContain("truncated");
  });

  it("event delegation ignores clicks outside .agent-url and .agent-copy", () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    const { container } = render(
      <AgentMarkdown text="Just plain text without url" />
    );

    const div = container.querySelector(".agent-markdown");
    fireEvent.click(div!);

    expect(writeTextMock).not.toHaveBeenCalled();
  });
});
