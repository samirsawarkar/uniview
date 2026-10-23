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
      "[x](javascript:alert(1))",
      "[x](file:///C:/secret)",
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
    expect(urls).toContain("javascript:alert(1)");
    expect(urls).toContain("file:///C:/secret");

    expect(container.querySelectorAll(".agent-link").length).toBe(5);
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
    expect(removed).toEqual(["[image: a]", "[image: a]"]);
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
      // A table's rows must be on consecutive lines.
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

  it("creates no network activity or forbidden elements when rendering large documents", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, "open");

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
        "Executive summary of untrusted input.",
        "![Remote Banner](https://evil.example.com/banner.jpg)",
        "![Data URI](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==)",
        "<script src='https://evil.example.com/payload.js'></script>",
        "<iframe src='https://evil.example.com/embed'></iframe>",
        "<link rel='stylesheet' href='https://evil.example.com/style.css'>",
        "[Malicious Link](https://evil.example.com/phish)",
        "<https://evil.example.com/autolink>",
        "| Col 1 | Col 2 |",
        "| :--- | :--- |",
        "| Data 1 | Data 2 |",
        "```python",
        "import requests\nrequests.get('https://example.com')",
        "```",
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
      expect(createdForbiddenTags).toEqual([]);
      expect(container.querySelectorAll("img").length).toBe(0);
      expect(container.querySelectorAll("script").length).toBe(0);
      expect(container.querySelectorAll("iframe").length).toBe(0);
      expect(container.querySelectorAll("link").length).toBe(0);
    } finally {
      fetchSpy.mockRestore();
      xhrSpy.mockRestore();
      createElementSpy.mockRestore();
    }
  });

  it("sanitizeLabel strips control, bidi, zero-width chars and caps length", () => {
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

    expect(sanitizeLabel("1234567890", 5)).toBe("12345…");
    expect(sanitizeLabel("12345", 5)).toBe("12345");
    expect(sanitizeLabel("123", 5)).toBe("123");

    expect(sanitizeLabel("🦊🐶🐱🐰🐻🐼", 3)).toBe("🦊🐶🐱…");
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

  it("clicking .agent-url copies its text and briefly adds copied class", async () => {
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

    const urlEl = container.querySelector(".agent-url");
    expect(urlEl).not.toBeNull();
    expect(urlEl?.textContent).toBe("https://specs.example.com/p13b");

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

  it("event delegation ignores clicks outside .agent-url", () => {
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
