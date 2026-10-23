import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  validateViewSpec,
  countNodes,
  maxDepth,
  VIEW_SPEC_LIMITS,
  VIEW_SCHEMA
} from "../../shared/viewspec.mjs";

describe("View Spec v1 Validator and Schema", () => {
  it("matches schema json on disk", () => {
    const schemaPath = path.resolve(__dirname, "../../shared/schemas/view-1.json");
    const content = fs.readFileSync(schemaPath, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed).toEqual(VIEW_SCHEMA);
  });

  describe("Valid Fixtures", () => {
    const validDir = path.resolve(__dirname, "../../fixtures/viewspec/valid");
    const validFiles = fs.readdirSync(validDir).filter(f => f.endsWith(".uview.json"));

    it("has at least 15 valid fixtures", () => {
      expect(validFiles.length).toBeGreaterThanOrEqual(15);
    });

    for (const file of validFiles) {
      it(`passes fixture: ${file}`, async () => {
        const filePath = path.join(validDir, file);
        const text = fs.readFileSync(filePath, "utf8");
        const res = await validateViewSpec(text);
        if (!res.ok) {
          console.error(`Validation failed for ${file}:`, res.errors);
        }
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.spec.uniview).toBe("view/1");
        }
      });
    }
  });

  describe("Invalid Fixtures", () => {
    const invalidDir = path.resolve(__dirname, "../../fixtures/viewspec/invalid");
    const invalidFiles = fs.readdirSync(invalidDir).filter(f => f.endsWith(".uview.json"));

    it("has at least 20 invalid fixtures", () => {
      expect(invalidFiles.length).toBeGreaterThanOrEqual(20);
    });

    for (const file of invalidFiles) {
      const expectedCode = file.split("--")[0];
      it(`fails fixture ${file} with code ${expectedCode}`, async () => {
        const filePath = path.join(invalidDir, file);
        const text = fs.readFileSync(filePath, "utf8");
        const res = await validateViewSpec(text);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          const hasCode = res.errors.some(e => e.code === expectedCode);
          expect(hasCode).toBe(true);
        }
      });
    }
  });

  describe("Limit and Limit+1 Edge Cases", () => {
    it("file size: 2 MiB passes, 2 MiB + 1 fails with too_large", async () => {
      const baseObj = { uniview: "view/1", title: "Limit Size", body: [] };
      const baseJson = JSON.stringify(baseObj);
      const targetPassBytes = VIEW_SPEC_LIMITS.MAX_FILE_BYTES;
      const passPadding = " ".repeat(targetPassBytes - Buffer.byteLength(baseJson, "utf8"));
      const passText = baseJson + passPadding;
      expect(Buffer.byteLength(passText, "utf8")).toBe(targetPassBytes);
      const resPass = await validateViewSpec(passText);
      expect(resPass.ok).toBe(true);

      const failText = passText + " ";
      expect(Buffer.byteLength(failText, "utf8")).toBe(targetPassBytes + 1);
      const resFail = await validateViewSpec(failText);
      expect(resFail.ok).toBe(false);
      if (!resFail.ok) {
        expect(resFail.errors[0]?.code).toBe("too_large");
      }
    });

    it("depth: 32 passes, 33 fails with too_deep", async () => {
      function makeDeepObj(targetDepth: number): Record<string, unknown> {
        let current: Record<string, unknown> = { type: "heading", text: "Leaf" };
        let depth = 4;
        while (depth < targetDepth) {
          current = { type: "section", children: [current as any] };
          depth += 2;
        }
        return {
          uniview: "view/1",
          title: "Depth Test",
          body: [current as any]
        };
      }

      const exact32 = makeDeepObj(32);
      expect(maxDepth(exact32)).toBe(32);
      const resPass = await validateViewSpec(exact32);
      expect(resPass.ok).toBe(true);

      let deep33: any = { type: "heading", text: "Deep" };
      for (let i = 0; i < 16; i++) {
        deep33 = { type: "section", children: [deep33] };
      }
      const spec33 = {
        uniview: "view/1",
        title: "Depth 33",
        body: [deep33]
      };
      expect(maxDepth(spec33)).toBeGreaterThan(32);
      const resFail = await validateViewSpec(spec33);
      expect(resFail.ok).toBe(false);
      if (!resFail.ok) {
        expect(resFail.errors[0]?.code).toBe("too_deep");
      }
    });

    it("node count: table cells limit and limit+1", async () => {
      const columns = Array.from({ length: 50 }, (_, i) => ({
        key: `c${i}`,
        label: `Col ${i}`
      }));
      const rowsPass = Array.from({ length: 999 }, () => ({}));
      const specPass = {
        uniview: "view/1",
        title: "Table Pass",
        body: [{ type: "table", columns, rows: rowsPass }]
      };
      expect(countNodes(specPass)).toBe(1 + 50 * 999);
      expect(countNodes(specPass)).toBeLessThanOrEqual(VIEW_SPEC_LIMITS.MAX_NODES);
      const resPass = await validateViewSpec(specPass);
      expect(resPass.ok).toBe(true);

      const rowsFail = Array.from({ length: 1000 }, () => ({}));
      const specFail = {
        uniview: "view/1",
        title: "Table Fail",
        body: [{ type: "table", columns, rows: rowsFail }]
      };
      expect(countNodes(specFail)).toBe(1 + 50 * 1000);
      expect(countNodes(specFail)).toBe(50001);
      const resFail = await validateViewSpec(specFail);
      expect(resFail.ok).toBe(false);
      if (!resFail.ok) {
        expect(resFail.errors[0]?.code).toBe("too_many_nodes");
      }
    });

    it("node count: tree entries limit and limit+1", async () => {
      function makeTreeNodes(count: number): any[] {
        const nodes: any[] = [];
        for (let i = 0; i < count; i++) {
          nodes.push({ label: `node-${i}` });
        }
        return nodes;
      }
      const treePass = {
        uniview: "view/1",
        title: "Tree Pass",
        body: [
          { type: "tree", nodes: makeTreeNodes(19999) },
          { type: "tree", nodes: makeTreeNodes(19999) },
          { type: "tree", nodes: makeTreeNodes(9999) }
        ]
      };
      expect(countNodes(treePass)).toBe(3 + 19999 + 19999 + 9999);
      expect(countNodes(treePass)).toBe(50000);
      const resPass = await validateViewSpec(treePass);
      expect(resPass.ok).toBe(true);

      const treeFail = {
        uniview: "view/1",
        title: "Tree Fail",
        body: [
          { type: "tree", nodes: makeTreeNodes(19999) },
          { type: "tree", nodes: makeTreeNodes(19999) },
          { type: "tree", nodes: makeTreeNodes(10000) }
        ]
      };
      expect(countNodes(treeFail)).toBe(50001);
      const resFail = await validateViewSpec(treeFail);
      expect(resFail.ok).toBe(false);
      if (!resFail.ok) {
        expect(resFail.errors[0]?.code).toBe("too_many_nodes");
      }
    });

    it("node count: chart points limit and limit+1", async () => {
      const x = Array.from({ length: 500 }, (_, i) => `x${i}`);
      const series = Array.from({ length: 9 }, (_, s) => ({
        name: `S${s}`,
        values: Array.from({ length: 500 }, () => 1)
      }));
      const charts: any[] = [];
      for (let i = 0; i < 11; i++) {
        charts.push({ type: "chart", kind: "line", x, series });
      }
      const spec = {
        uniview: "view/1",
        title: "Chart Node Count",
        body: charts
      };
      expect(countNodes(spec)).toBe(11 + 11 * 4500);
      expect(countNodes(spec)).toBe(49511);
      const resPass = await validateViewSpec(spec);
      expect(resPass.ok).toBe(true);

      charts.push({ type: "chart", kind: "line", x: ["a", "b"], series: [{ name: "s", values: [1, 2] }] });
      const series10 = Array.from({ length: 10 }, (_, s) => ({
        name: `S${s}`,
        values: Array.from({ length: 500 }, () => 1)
      }));
      const chartsFail: any[] = [];
      for (let i = 0; i < 10; i++) {
        chartsFail.push({ type: "chart", kind: "line", x, series: series10 });
      }
      chartsFail.push({ type: "heading", text: "Extra" });
      const specFail = {
        uniview: "view/1",
        title: "Chart Fail",
        body: chartsFail
      };
      expect(countNodes(specFail)).toBe(50011);
      const resFail = await validateViewSpec(specFail);
      expect(resFail.ok).toBe(false);
      if (!resFail.ok) {
        expect(resFail.errors[0]?.code).toBe("too_many_nodes");
      }
    });

    it("node count: list items limit and limit+1", async () => {
      const items = Array.from({ length: 999 }, (_, i) => `item-${i}`);
      const lists: any[] = [];
      for (let i = 0; i < 50; i++) {
        lists.push({ type: "list", items });
      }
      const specPass = {
        uniview: "view/1",
        title: "List Pass",
        body: lists
      };
      expect(countNodes(specPass)).toBe(50 + 50 * 999);
      expect(countNodes(specPass)).toBe(50000);
      const resPass = await validateViewSpec(specPass);
      expect(resPass.ok).toBe(true);

      lists.push({ type: "heading", text: "One more" });
      const specFail = {
        uniview: "view/1",
        title: "List Fail",
        body: lists
      };
      expect(countNodes(specFail)).toBe(50001);
      const resFail = await validateViewSpec(specFail);
      expect(resFail.ok).toBe(false);
      if (!resFail.ok) {
        expect(resFail.errors[0]?.code).toBe("too_many_nodes");
      }
    });

    it("string lengths: title 200/201 and heading 300/301", async () => {
      const title200 = "T".repeat(200);
      const resTitle200 = await validateViewSpec({
        uniview: "view/1",
        title: title200,
        body: []
      });
      expect(resTitle200.ok).toBe(true);

      const title201 = "T".repeat(201);
      const resTitle201 = await validateViewSpec({
        uniview: "view/1",
        title: title201,
        body: []
      });
      expect(resTitle201.ok).toBe(false);
      if (!resTitle201.ok) {
        expect(resTitle201.errors.some(e => e.code === "schema" && e.path === "/title")).toBe(true);
      }

      const h300 = "H".repeat(300);
      const resH300 = await validateViewSpec({
        uniview: "view/1",
        title: "Heading 300",
        body: [{ type: "heading", text: h300 }]
      });
      expect(resH300.ok).toBe(true);

      const h301 = "H".repeat(301);
      const resH301 = await validateViewSpec({
        uniview: "view/1",
        title: "Heading 301",
        body: [{ type: "heading", text: h301 }]
      });
      expect(resH301.ok).toBe(false);
      if (!resH301.ok) {
        expect(resH301.errors.some(e => e.code === "schema" && e.path.includes("text"))).toBe(true);
      }
    });

    it("columns count: 2 and 3 pass; 1 and 4 fail", async () => {
      const col = [{ type: "markdown", text: "Text" }];
      const res2 = await validateViewSpec({
        uniview: "view/1",
        title: "2 cols",
        body: [{ type: "columns", columns: [col, col] }]
      });
      expect(res2.ok).toBe(true);

      const res3 = await validateViewSpec({
        uniview: "view/1",
        title: "3 cols",
        body: [{ type: "columns", columns: [col, col, col] }]
      });
      expect(res3.ok).toBe(true);

      const res1 = await validateViewSpec({
        uniview: "view/1",
        title: "1 col",
        body: [{ type: "columns", columns: [col] }]
      });
      expect(res1.ok).toBe(false);
      if (!res1.ok) {
        expect(res1.errors.some(e => e.code === "schema")).toBe(true);
      }

      const res4 = await validateViewSpec({
        uniview: "view/1",
        title: "4 cols",
        body: [{ type: "columns", columns: [col, col, col, col] }]
      });
      expect(res4.ok).toBe(false);
      if (!res4.ok) {
        expect(res4.errors.some(e => e.code === "schema")).toBe(true);
      }
    });

    it("chart series: 10 passes, 11 fails", async () => {
      const x = ["Q1"];
      const series10 = Array.from({ length: 10 }, (_, i) => ({
        name: `S${i}`,
        values: [100]
      }));
      const res10 = await validateViewSpec({
        uniview: "view/1",
        title: "Chart 10",
        body: [{ type: "chart", kind: "bar", x, series: series10 }]
      });
      expect(res10.ok).toBe(true);

      const series11 = Array.from({ length: 11 }, (_, i) => ({
        name: `S${i}`,
        values: [100]
      }));
      const res11 = await validateViewSpec({
        uniview: "view/1",
        title: "Chart 11",
        body: [{ type: "chart", kind: "bar", x, series: series11 }]
      });
      expect(res11.ok).toBe(false);
      if (!res11.ok) {
        expect(res11.errors.some(e => e.code === "schema")).toBe(true);
      }
    });

    it("rejects unknown field anywhere with schema and proper path", async () => {
      const resTop = await validateViewSpec({
        uniview: "view/1",
        title: "Top Unknown",
        unexpectedProperty: 123,
        body: []
      });
      expect(resTop.ok).toBe(false);
      if (!resTop.ok) {
        expect(resTop.errors.some(e => e.code === "schema" && (e.path === "/unexpectedProperty" || e.path === ""))).toBe(true);
      }

      const resNode = await validateViewSpec({
        uniview: "view/1",
        title: "Node Unknown",
        body: [
          {
            type: "heading",
            text: "Hello",
            extraField: true
          }
        ]
      });
      expect(resNode.ok).toBe(false);
      if (!resNode.ok) {
        expect(resNode.errors.some(e => e.code === "schema")).toBe(true);
      }
    });

    it("rejects diff with both unified and before/after", async () => {
      const resDiff = await validateViewSpec({
        uniview: "view/1",
        title: "Dual Diff",
        body: [
          {
            type: "diff",
            unified: "@@ -1 +1 @@",
            before: "old",
            after: "new"
          }
        ]
      });
      expect(resDiff.ok).toBe(false);
      if (!resDiff.ok) {
        expect(resDiff.errors.some(e => e.code === "schema")).toBe(true);
      }
    });

    it("rejects relPath with .. with bad_path", async () => {
      const resRel = await validateViewSpec({
        uniview: "view/1",
        title: "DotDot RelPath",
        body: [
          {
            type: "image",
            path: "/var/images/test.png",
            relPath: "sub/../escaped.png",
            alt: "Escape"
          }
        ]
      });
      expect(resRel.ok).toBe(false);
      if (!resRel.ok) {
        expect(resRel.errors.some(e => e.code === "bad_path" && e.path === "/body/0/relPath")).toBe(true);
      }
    });
  });
});
