import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fs from "node:fs";
import path from "node:path";
import ViewSpecViewer from "../../src/viewers/ViewSpecViewer";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeSource(data: string | object, size?: number) {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  const bytes = new TextEncoder().encode(text);
  return {
    name: "test.uview.json",
    size: size ?? bytes.byteLength,
    readAll: async () => bytes,
  };
}

describe("ViewSpecViewer", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
    }
    container?.remove();
    container = null;
    root = null;
  });

  async function renderAndWait(source: any) {
    let ready = false;
    await act(async () => {
      root!.render(
        <ViewSpecViewer
          source={source}
          detection={{ kind: "viewspec", ext: "uview.json", by: "extension", label: "UniView view" }}
          onOpen={() => {}}
          onReady={() => {
            ready = true;
          }}
        />
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    return ready;
  }

  it("renders valid fixtures from disk if available", async () => {
    const validDir = path.resolve(process.cwd(), "fixtures/viewspec/valid");
    if (fs.existsSync(validDir)) {
      const files = fs.readdirSync(validDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const text = fs.readFileSync(path.join(validDir, file), "utf-8");
        const source = makeSource(text);
        await renderAndWait(source);
        expect(container?.querySelector("section.agent-content")).not.toBeNull();
      }
    }
  });

  it("renders node-specific elements for all standard node types", async () => {
    const spec = {
      uniview: "view/1",
      title: "All Types Spec",
      agent: { name: "TestBot" },
      body: [
        { type: "heading", level: 1, text: "Heading 1" },
        { type: "heading", level: 2, text: "Heading 2" },
        { type: "heading", level: 3, text: "Heading 3" },
        { type: "heading", level: 4, text: "Heading 4" },
        { type: "markdown", text: "**Bold markdown**" },
        { type: "callout", tone: "info", title: "Note", text: "Important text" },
        {
          type: "keyValue",
          items: [{ key: "Status", value: "Active" }],
        },
        {
          type: "table",
          columns: [
            { key: "c1", label: "Col 1", align: "left" },
            { key: "c2", label: "Col 2", align: "right" },
          ],
          rows: [{ c1: "val1", c2: 123 }],
        },
        { type: "list", ordered: false, items: ["item 1", "item 2"] },
        { type: "list", ordered: true, items: ["ordered 1"] },
        {
          type: "tree",
          nodes: [{ label: "Root", detail: "info", children: [{ label: "Child" }] }],
        },
        {
          type: "code",
          text: "const x = 1;\nconst y = 2;",
          language: "javascript",
          highlightLines: [[1, 1]],
        },
        {
          type: "diff",
          unified: "@@ -1,2 +1,2 @@\n-old line\n+new line\n",
        },
        {
          type: "chart",
          kind: "bar",
          x: ["A", "B"],
          series: [{ name: "S1", values: [10, 20] }],
        },
        {
          type: "section",
          title: "Section 1",
          children: [{ type: "markdown", text: "Section body" }],
        },
        {
          type: "columns",
          columns: [[{ type: "markdown", text: "Col text" }], [{ type: "markdown", text: "Col two" }]],
        },
        { type: "image", path: "C:/work/img.png", alt: "Alt text", caption: "Caption text" },
        { type: "fileRef", path: "C:/work/src/main.rs", label: "Main file" },
      ],
    };

    const source = makeSource(spec);
    await renderAndWait(source);

    expect(container?.querySelector(".vs-error-heading")).toBeNull();
    expect(container?.querySelector("h2")).not.toBeNull();
    expect(container?.querySelector("h3")).not.toBeNull();
    expect(container?.querySelector("h4")).not.toBeNull();
    expect(container?.querySelector("h5")).not.toBeNull();
    expect(container?.querySelector(".agent-markdown")).not.toBeNull();
    expect(container?.querySelector(".vs-callout.tone-info")).not.toBeNull();
    expect(container?.querySelector("dl.vs-key-value")).not.toBeNull();

    const table = container?.querySelector("table.vs-table");
    expect(table).not.toBeNull();
    const ths = container?.querySelectorAll("table th");
    expect(ths?.[0]?.textContent).toBe("Col 1");
    expect(ths?.[1]?.textContent).toBe("Col 2");

    expect(container?.querySelector("ul.vs-list")).not.toBeNull();
    expect(container?.querySelector("ol.vs-list")).not.toBeNull();
    expect(container?.querySelector("details.vs-tree-entry")).not.toBeNull();

    expect(container?.querySelector("pre.vs-code-pre code")).not.toBeNull();
    expect(container?.querySelector(".vs-hl")).not.toBeNull();

    expect(container?.querySelector(".vs-diff-add, .diff-add")).not.toBeNull();
    expect(container?.querySelector(".vs-diff-del, .diff-del")).not.toBeNull();

    expect(container?.querySelector('svg[role="img"]')).not.toBeNull();

    const placeholders = container?.querySelectorAll(".vs-placeholder");
    expect(placeholders?.length).toBeGreaterThanOrEqual(2);
    expect(container?.textContent).toContain("Images in agent views appear when an agent opens this view through UniView");
  });

  it("all-nodes-nested renders without errors", async () => {
    const nestedSpec = {
      uniview: "view/1",
      title: "Nested View",
      agent: { name: "AgentNested" },
      body: [
        {
          type: "section",
          title: "Outer Section",
          children: [
            {
              type: "columns",
              columns: [
                [
                  {
                    type: "callout",
                    tone: "success",
                    text: "Callout inside column",
                  },
                ],
                [
                  {
                    type: "table",
                    columns: [{ key: "k", label: "Key" }],
                    rows: [{ k: "Nested value" }],
                  },
                ],
              ],
            },
          ],
        },
      ],
    };

    const source = makeSource(nestedSpec);
    await renderAndWait(source);

    expect(container?.querySelector("section.agent-content")).not.toBeNull();
    expect(container?.querySelector(".vs-section")).not.toBeNull();
    expect(container?.querySelector(".vs-columns")).not.toBeNull();
    expect(container?.querySelector(".vs-callout")).not.toBeNull();
    expect(container?.querySelector("table")).not.toBeNull();
  });

  it("invalid fixture shows error view with its code and Show as JSON toggle works", async () => {
    const invalidData = JSON.stringify({
      uniview: "invalid/version",
      title: "Bad Spec",
    });

    const source = makeSource(invalidData);
    await renderAndWait(source);

    expect(container?.textContent).toContain("This view could not be shown");
    expect(container?.querySelector(".vs-raw-json")).toBeNull();

    const toggleBtn = Array.from(container?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent?.includes("Show as JSON")
    );
    expect(toggleBtn).toBeDefined();

    await act(async () => {
      toggleBtn!.click();
    });

    const rawPre = container?.querySelector(".vs-raw-json");
    expect(rawPre).not.toBeNull();
    expect(rawPre?.textContent).toContain("invalid/version");

    await act(async () => {
      toggleBtn!.click();
    });
    expect(container?.querySelector(".vs-raw-json")).toBeNull();
  });

  it("agent name with bidi override character is sanitized in the header", async () => {
    const spec = {
      uniview: "view/1",
      title: "Bidi Spec",
      agent: { name: "Agent\u202EOverride" },
      body: [{ type: "markdown", text: "Text" }],
    };

    const source = makeSource(spec);
    await renderAndWait(source);

    const header = container?.querySelector(".vs-header");
    expect(header?.textContent).toContain("View from an agent · says it is AgentOverride");
    expect(header?.textContent).not.toContain("\u202E");
  });

  it("a heading without a level renders as level 2 (h3)", async () => {
    // Catches: a default level other than the spec's 2.
    await renderAndWait(makeSource({ uniview: "view/1", title: "T", body: [{ type: "heading", text: "Plain" }] }));
    const h = container?.querySelector(".vs-heading");
    expect(h?.tagName).toBe("H3");
    expect(h?.textContent).toBe("Plain");
  });

  it("code with markup stays text, highlighted or not", async () => {
    // Catches: rendering code lines as HTML without highlight.js escaping.
    const attack = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const spec = {
      uniview: "view/1",
      title: "Code",
      body: [
        { type: "code", language: "javascript", text: `const a = '${attack}';\nlet b = 1;` },
        { type: "code", text: attack },
      ],
    };
    await renderAndWait(makeSource(spec));
    expect(container?.querySelector("img")).toBeNull();
    expect(container?.querySelector("script")).toBeNull();
    const codes = container?.querySelectorAll("code.vs-code");
    expect(codes?.length).toBe(2);
    expect(codes?.[0]?.textContent).toContain(attack);
    expect(codes?.[1]?.textContent).toContain(attack);
  });

  it("no a, img, script or iframe element and no fetch call during any render", async () => {
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as any;

    try {
      const spec = {
        uniview: "view/1",
        title: "Security Spec",
        body: [
          { type: "image", path: "C:/work/test.png", alt: "Secret photo" },
          { type: "fileRef", path: "/etc/passwd", label: "Secret file" },
          { type: "markdown", text: "[Link](https://example.com) and ![Img](https://example.com/a.png)" },
        ],
      };

      const source = makeSource(spec);
      await renderAndWait(source);

      expect(container?.querySelector(".vs-error-heading")).toBeNull();
      expect(container?.querySelector(".agent-content")).not.toBeNull();
      expect(container?.querySelector("a")).toBeNull();
      expect(container?.querySelector("img")).toBeNull();
      expect(container?.querySelector("script")).toBeNull();
      expect(container?.querySelector("iframe")).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("table with 1200 rows shows 500 then 1000 after one click", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      id: i + 1,
      val: `Row ${i + 1}`,
    }));
    const spec = {
      uniview: "view/1",
      title: "Large Table",
      body: [
        {
          type: "table",
          columns: [
            { key: "id", label: "ID" },
            { key: "val", label: "Value" },
          ],
          rows,
        },
      ],
    };

    const source = makeSource(spec);
    await renderAndWait(source);

    let trs = container?.querySelectorAll("tbody tr");
    expect(trs?.length).toBe(500);

    const moreBtn = container?.querySelector(".vs-more-rows") as HTMLButtonElement;
    expect(moreBtn).not.toBeNull();
    expect(moreBtn.textContent).toContain("700 left");

    await act(async () => {
      moreBtn.click();
    });

    trs = container?.querySelectorAll("tbody tr");
    expect(trs?.length).toBe(1000);
  });
});
