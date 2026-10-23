import { describe, it, expect } from "vitest";
import { validateViewSpec, VIEW_SPEC_LIMITS } from "../../shared/viewspec.mjs";

function makeSpec(node: Record<string, unknown>) {
  return {
    uniview: "view/1",
    title: "Limits Test",
    body: [node]
  };
}

function makeExactBytes(bytes: number): string {
  const eCount = Math.floor(bytes / 2);
  const rem = bytes % 2;
  return "é".repeat(eCount) + (rem === 1 ? "a" : "");
}

describe("P13d Limits and review fixes", () => {
  // Catches mutation: removing countTreeNodesTotal check in runSemanticChecks
  it("tree entries at exact limit (20 000) and limit + 1 (20 001)", async () => {
    const validNodes = Array.from({ length: 20000 }, (_, i) => ({ label: `node-${i}` }));
    const validSpec = makeSpec({ type: "tree", nodes: validNodes });
    const validRes = await validateViewSpec(validSpec);
    expect(validRes.ok).toBe(true);

    const invalidNodes = Array.from({ length: 20001 }, (_, i) => ({ label: `node-${i}` }));
    const invalidSpec = makeSpec({ type: "tree", nodes: invalidNodes });
    const invalidRes = await validateViewSpec(invalidSpec);
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.errors?.[0]?.code).toBe("schema");
    expect(invalidRes.errors?.[0]?.path).toBe("/body/0/nodes");
    expect(invalidRes.errors?.[0]?.message).toContain("Tree entries count");
  });

  // Catches mutation: using x.length * series.length instead of summing series values in countNodes
  it("chart points via values budget (49 999 values pass node budget, 50 000 and 50 001 hit too_many_nodes)", async () => {
    const okSpec = makeSpec({
      type: "chart",
      kind: "line",
      x: ["a"],
      series: [{ name: "s", values: Array.from({ length: 49999 }, () => 1) }]
    });
    const okRes = await validateViewSpec(okSpec);
    expect(okRes.errors?.some(e => e.code === "too_many_nodes")).toBe(false);

    const at50kSpec = makeSpec({
      type: "chart",
      kind: "line",
      x: ["a"],
      series: [{ name: "s", values: Array.from({ length: 50000 }, () => 1) }]
    });
    const at50kRes = await validateViewSpec(at50kSpec);
    expect(at50kRes.ok).toBe(false);
    expect(at50kRes.errors?.[0]?.code).toBe("too_many_nodes");

    const over50kSpec = makeSpec({
      type: "chart",
      kind: "line",
      x: ["a"],
      series: [{ name: "s", values: Array.from({ length: 50001 }, () => 1) }]
    });
    const over50kRes = await validateViewSpec(over50kSpec);
    expect(over50kRes.ok).toBe(false);
    expect(over50kRes.errors?.[0]?.code).toBe("too_many_nodes");
  });

  // Catches mutation: changing table rows schema maxItems
  it("table rows limit (10 000) and limit + 1 (10 001)", async () => {
    const validRows = Array.from({ length: 10000 }, () => ({ c: 1 }));
    const validSpec = makeSpec({
      type: "table",
      columns: [{ key: "c", label: "C" }],
      rows: validRows
    });
    const validRes = await validateViewSpec(validSpec);
    expect(validRes.ok).toBe(true);

    const invalidRows = Array.from({ length: 10001 }, () => ({ c: 1 }));
    const invalidSpec = makeSpec({
      type: "table",
      columns: [{ key: "c", label: "C" }],
      rows: invalidRows
    });
    const invalidRes = await validateViewSpec(invalidSpec);
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.errors?.[0]?.code).toBe("schema");
    expect(invalidRes.errors?.some((e) => e.path === "/body/0/rows")).toBe(true);
  });

  // Catches mutation: changing table columns schema maxItems
  it("table columns limit (50) and limit + 1 (51)", async () => {
    const validCols = Array.from({ length: 50 }, (_, i) => ({ key: `c${i}`, label: `Col ${i}` }));
    const validRes = await validateViewSpec(makeSpec({ type: "table", columns: validCols, rows: [] }));
    expect(validRes.ok).toBe(true);

    const invalidCols = Array.from({ length: 51 }, (_, i) => ({ key: `c${i}`, label: `Col ${i}` }));
    const invalidRes = await validateViewSpec(makeSpec({ type: "table", columns: invalidCols, rows: [] }));
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.errors?.[0]?.code).toBe("schema");
    expect(invalidRes.errors?.some((e) => e.path === "/body/0/columns")).toBe(true);
  });

  // Catches mutation: changing keyValue maxItems
  it("keyValue items limit (500) and limit + 1 (501)", async () => {
    const validItems = Array.from({ length: 500 }, (_, i) => ({ key: `k${i}`, value: `v${i}` }));
    const validRes = await validateViewSpec(makeSpec({ type: "keyValue", items: validItems }));
    expect(validRes.ok).toBe(true);

    const invalidItems = Array.from({ length: 501 }, (_, i) => ({ key: `k${i}`, value: `v${i}` }));
    const invalidRes = await validateViewSpec(makeSpec({ type: "keyValue", items: invalidItems }));
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.errors?.[0]?.code).toBe("schema");
    expect(invalidRes.errors?.some((e) => e.path === "/body/0/items")).toBe(true);
  });

  // Catches mutation: changing list items maxItems
  it("list items limit (1000) and limit + 1 (1001)", async () => {
    const validItems = Array.from({ length: 1000 }, (_, i) => `item-${i}`);
    const validRes = await validateViewSpec(makeSpec({ type: "list", items: validItems }));
    expect(validRes.ok).toBe(true);

    const invalidItems = Array.from({ length: 1001 }, (_, i) => `item-${i}`);
    const invalidRes = await validateViewSpec(makeSpec({ type: "list", items: invalidItems }));
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.errors?.[0]?.code).toBe("schema");
    expect(invalidRes.errors?.some((e) => e.path === "/body/0/items")).toBe(true);
  });

  // Catches mutation: changing chart x maxItems
  it("chart x limit (500) and limit + 1 (501)", async () => {
    const validX = Array.from({ length: 500 }, (_, i) => `x${i}`);
    const validRes = await validateViewSpec(makeSpec({
      type: "chart",
      kind: "bar",
      x: validX,
      series: [{ name: "s", values: Array.from({ length: 500 }, () => 1) }]
    }));
    expect(validRes.ok).toBe(true);

    const invalidX = Array.from({ length: 501 }, (_, i) => `x${i}`);
    const invalidRes = await validateViewSpec(makeSpec({
      type: "chart",
      kind: "bar",
      x: invalidX,
      series: [{ name: "s", values: Array.from({ length: 501 }, () => 1) }]
    }));
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.errors?.[0]?.code).toBe("schema");
    expect(invalidRes.errors?.some((e) => e.path === "/body/0/x")).toBe(true);
  });

  // Catches mutation: changing chart series maxItems
  it("chart series limit (10) and limit + 1 (11)", async () => {
    const validSeries = Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, values: [1] }));
    const validRes = await validateViewSpec(makeSpec({ type: "chart", kind: "line", x: ["a"], series: validSeries }));
    expect(validRes.ok).toBe(true);

    const invalidSeries = Array.from({ length: 11 }, (_, i) => ({ name: `s${i}`, values: [1] }));
    const invalidRes = await validateViewSpec(makeSpec({ type: "chart", kind: "line", x: ["a"], series: invalidSeries }));
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.errors?.[0]?.code).toBe("schema");
    expect(invalidRes.errors?.some((e) => e.path === "/body/0/series")).toBe(true);
  });

  // Catches mutation: changing MAX_DEPTH calculation or threshold
  it("depth limit (32) and limit + 1 (33)", async () => {
    function buildDepthSpec(targetDepth: number) {
      let inner: any = { type: "markdown", text: "leaf" };
      let needed = targetDepth - 4;
      if (needed % 2 !== 0) {
        inner = { type: "columns", columns: [[inner], [{ type: "markdown", text: "col" }]] };
        needed -= 3;
      }
      while (needed > 0) {
        inner = { type: "section", children: [inner] };
        needed -= 2;
      }
      return { uniview: "view/1", title: "Depth", body: [inner] };
    }

    const res32 = await validateViewSpec(buildDepthSpec(32));
    expect(res32.ok).toBe(true);

    const res33 = await validateViewSpec(buildDepthSpec(33));
    expect(res33.ok).toBe(false);
    expect(res33.errors?.[0]?.code).toBe("too_deep");
  });

  // Catches mutation: changing MAX_NODES limit
  it("total nodes limit (50 000) and limit + 1 (50 001)", async () => {
    const tableCols = Array.from({ length: 5 }, (_, i) => ({ key: `c${i}`, label: `C${i}` }));
    const tableRows = Array.from({ length: 9999 }, () => ({ c0: 1, c1: 1, c2: 1, c3: 1, c4: 1 }));
    const tableNode = { type: "table", columns: tableCols, rows: tableRows };

    const spec50k = {
      uniview: "view/1",
      title: "Nodes Test",
      body: [
        tableNode,
        { type: "markdown", text: "1" },
        { type: "markdown", text: "2" },
        { type: "markdown", text: "3" },
        { type: "markdown", text: "4" }
      ]
    };
    const res50k = await validateViewSpec(spec50k);
    expect(res50k.ok).toBe(true);

    const spec50k1 = {
      uniview: "view/1",
      title: "Nodes Test",
      body: [
        tableNode,
        { type: "markdown", text: "1" },
        { type: "markdown", text: "2" },
        { type: "markdown", text: "3" },
        { type: "markdown", text: "4" },
        { type: "markdown", text: "5" }
      ]
    };
    const res50k1 = await validateViewSpec(spec50k1);
    expect(res50k1.ok).toBe(false);
    expect(res50k1.errors?.[0]?.code).toBe("too_many_nodes");
  });

  // Catches mutation: using code points instead of UTF-8 byte length for markdown.text
  it("markdown.text UTF-8 byte limit (256 KiB = 262 144 bytes) and limit + 1 (262 145)", async () => {
    const limit = 256 * 1024;
    const okSpec = makeSpec({ type: "markdown", text: makeExactBytes(limit) });
    const okRes = await validateViewSpec(okSpec);
    expect(okRes.ok).toBe(true);

    const failSpec = makeSpec({ type: "markdown", text: makeExactBytes(limit + 1) });
    const failRes = await validateViewSpec(failSpec);
    expect(failRes.ok).toBe(false);
    expect(failRes.errors?.[0]?.code).toBe("schema");
    expect(failRes.errors?.[0]?.path).toBe("/body/0/text");
    expect(failRes.errors?.[0]?.message).toBe(`too long (${limit + 1} bytes, limit ${limit})`);
  });

  // Catches mutation: using code points instead of UTF-8 byte length for callout.text
  it("callout.text UTF-8 byte limit (256 KiB = 262 144 bytes) and limit + 1 (262 145)", async () => {
    const limit = 256 * 1024;
    const okSpec = makeSpec({ type: "callout", tone: "info", text: makeExactBytes(limit) });
    const okRes = await validateViewSpec(okSpec);
    expect(okRes.ok).toBe(true);

    const failSpec = makeSpec({ type: "callout", tone: "info", text: makeExactBytes(limit + 1) });
    const failRes = await validateViewSpec(failSpec);
    expect(failRes.ok).toBe(false);
    expect(failRes.errors?.[0]?.code).toBe("schema");
    expect(failRes.errors?.[0]?.path).toBe("/body/0/text");
    expect(failRes.errors?.[0]?.message).toBe(`too long (${limit + 1} bytes, limit ${limit})`);
  });

  // Catches mutation: using code points instead of UTF-8 byte length for code.text
  it("code.text UTF-8 byte limit (512 KiB = 524 288 bytes) and limit + 1 (524 289)", async () => {
    const limit = 512 * 1024;
    const okSpec = makeSpec({ type: "code", text: makeExactBytes(limit) });
    const okRes = await validateViewSpec(okSpec);
    expect(okRes.ok).toBe(true);

    const failSpec = makeSpec({ type: "code", text: makeExactBytes(limit + 1) });
    const failRes = await validateViewSpec(failSpec);
    expect(failRes.ok).toBe(false);
    expect(failRes.errors?.[0]?.code).toBe("schema");
    expect(failRes.errors?.[0]?.path).toBe("/body/0/text");
    expect(failRes.errors?.[0]?.message).toBe(`too long (${limit + 1} bytes, limit ${limit})`);
  });

  // Catches mutation: using code points instead of UTF-8 byte length for diff.unified
  it("diff.unified UTF-8 byte limit (512 KiB = 524 288 bytes) and limit + 1 (524 289)", async () => {
    const limit = 512 * 1024;
    const okSpec = makeSpec({ type: "diff", unified: makeExactBytes(limit) });
    const okRes = await validateViewSpec(okSpec);
    expect(okRes.ok).toBe(true);

    const failSpec = makeSpec({ type: "diff", unified: makeExactBytes(limit + 1) });
    const failRes = await validateViewSpec(failSpec);
    expect(failRes.ok).toBe(false);
    expect(failRes.errors?.[0]?.code).toBe("schema");
    expect(failRes.errors?.[0]?.path).toBe("/body/0/unified");
    expect(failRes.errors?.[0]?.message).toBe(`too long (${limit + 1} bytes, limit ${limit})`);
  });

  // Catches mutation: using code points instead of UTF-8 byte length for diff.before
  it("diff.before UTF-8 byte limit (512 KiB = 524 288 bytes) and limit + 1 (524 289)", async () => {
    const limit = 512 * 1024;
    const okSpec = makeSpec({ type: "diff", before: makeExactBytes(limit), after: "after" });
    const okRes = await validateViewSpec(okSpec);
    expect(okRes.ok).toBe(true);

    const failSpec = makeSpec({ type: "diff", before: makeExactBytes(limit + 1), after: "after" });
    const failRes = await validateViewSpec(failSpec);
    expect(failRes.ok).toBe(false);
    expect(failRes.errors?.[0]?.code).toBe("schema");
    expect(failRes.errors?.[0]?.path).toBe("/body/0/before");
    expect(failRes.errors?.[0]?.message).toBe(`too long (${limit + 1} bytes, limit ${limit})`);
  });

  // Catches mutation: using code points instead of UTF-8 byte length for diff.after
  it("diff.after UTF-8 byte limit (512 KiB = 524 288 bytes) and limit + 1 (524 289)", async () => {
    const limit = 512 * 1024;
    const okSpec = makeSpec({ type: "diff", before: "before", after: makeExactBytes(limit) });
    const okRes = await validateViewSpec(okSpec);
    expect(okRes.ok).toBe(true);

    const failSpec = makeSpec({ type: "diff", before: "before", after: makeExactBytes(limit + 1) });
    const failRes = await validateViewSpec(failSpec);
    expect(failRes.ok).toBe(false);
    expect(failRes.errors?.[0]?.code).toBe("schema");
    expect(failRes.errors?.[0]?.path).toBe("/body/0/after");
    expect(failRes.errors?.[0]?.message).toBe(`too long (${limit + 1} bytes, limit ${limit})`);
  });

  // Catches mutation: using code points instead of UTF-8 byte length for keyValue.value
  it("keyValue.value UTF-8 byte limit (4 KiB = 4096 bytes) and limit + 1 (4097)", async () => {
    const limit = 4096;
    const okSpec = makeSpec({ type: "keyValue", items: [{ key: "k", value: makeExactBytes(limit) }] });
    const okRes = await validateViewSpec(okSpec);
    expect(okRes.ok).toBe(true);

    const failSpec = makeSpec({ type: "keyValue", items: [{ key: "k", value: makeExactBytes(limit + 1) }] });
    const failRes = await validateViewSpec(failSpec);
    expect(failRes.ok).toBe(false);
    expect(failRes.errors?.[0]?.code).toBe("schema");
    expect(failRes.errors?.[0]?.path).toBe("/body/0/items/0/value");
    expect(failRes.errors?.[0]?.message).toBe(`too long (${limit + 1} bytes, limit ${limit})`);
  });

  // Catches mutation: using code points instead of UTF-8 byte length for table string cells
  it("table string cell UTF-8 byte limit (4 KiB = 4096 bytes) and limit + 1 (4097)", async () => {
    const limit = 4096;
    const okSpec = makeSpec({
      type: "table",
      columns: [{ key: "c", label: "C" }],
      rows: [{ c: makeExactBytes(limit) }]
    });
    const okRes = await validateViewSpec(okSpec);
    expect(okRes.ok).toBe(true);

    const failSpec = makeSpec({
      type: "table",
      columns: [{ key: "c", label: "C" }],
      rows: [{ c: makeExactBytes(limit + 1) }]
    });
    const failRes = await validateViewSpec(failSpec);
    expect(failRes.ok).toBe(false);
    expect(failRes.errors?.[0]?.code).toBe("schema");
    expect(failRes.errors?.[0]?.path).toBe("/body/0/rows/0/c");
    expect(failRes.errors?.[0]?.message).toBe(`too long (${limit + 1} bytes, limit ${limit})`);
  });

  // Catches mutation: using code points instead of UTF-8 byte length for tree.detail (tested with 4-byte 😀)
  it("tree.detail UTF-8 byte limit (1 KiB = 1024 bytes) and limit + 1 (1025) with 4-byte characters", async () => {
    const limit = 1024;
    // 256 😀 emojis = 1024 UTF-8 bytes (code point length is 512)
    const exact1024 = "😀".repeat(256);
    const okSpec = makeSpec({ type: "tree", nodes: [{ label: "root", detail: exact1024 }] });
    const okRes = await validateViewSpec(okSpec);
    expect(okRes.ok).toBe(true);

    // 256 😀 emojis + 'a' = 1025 UTF-8 bytes (code point length is 513 <= 1024)
    const over1024 = "😀".repeat(256) + "a";
    const failSpec = makeSpec({ type: "tree", nodes: [{ label: "root", detail: over1024 }] });
    const failRes = await validateViewSpec(failSpec);
    expect(failRes.ok).toBe(false);
    expect(failRes.errors?.[0]?.code).toBe("schema");
    expect(failRes.errors?.[0]?.path).toBe("/body/0/nodes/0/detail");
    expect(failRes.errors?.[0]?.message).toBe(`too long (1025 bytes, limit 1024)`);
  });

  // Catches mutation: failing to escape ~ to ~0 and / to ~1 in JSON pointer paths for row keys
  it("RFC 6901 pointer escaping for ~ and / keys in table rows", async () => {
    const spec = makeSpec({
      type: "table",
      columns: [{ key: "c1", label: "Col 1" }],
      rows: [{ c1: "val", "a/b~c": "undeclared" }]
    });
    const res = await validateViewSpec(spec);
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe("schema");
    expect(res.errors?.[0]?.path).toBe("/body/0/rows/0/a~1b~0c");
    expect(res.errors?.[0]?.message).toContain("Row key 'a/b~c' is not a declared column key");
  });

  // Catches mutation: allowing .. segment in relPath
  it("rejects relPath with .. segments", async () => {
    const invalidImageSpec = makeSpec({
      type: "image",
      path: "/absolute/path.png",
      relPath: "foo/../bar.png",
      alt: "alt"
    });
    const res = await validateViewSpec(invalidImageSpec);
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe("bad_path");
    expect(res.errors?.[0]?.path).toBe("/body/0/relPath");
  });

  // Catches mutation: missing invalid_json code on JSON parse failure
  it("reports invalid_json on malformed JSON string", async () => {
    const res = await validateViewSpec("{ invalid json string");
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe("invalid_json");
  });
});
