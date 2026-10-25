// Builds the demo review: a receipt (with real SHA-256 hashes of the demo files) and a view.
// Run: node demo/make-demo.mjs   (from the project folder)
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = resolve(here, "files");
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const abs = (name) => join(files, name).replace(/\\/g, "/");

const receipt = {
  uniview: "receipt/1",
  createdAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  agent: { name: "Demo assistant", model: "example-model", run: "demo-run-1" },
  task: "Prepare the quarterly sales pack: update the sales workbook, the summary notes and the app config.",
  summary:
    "## What I did\n\nI updated **three files** for the quarterly pack.\n\n- `sales.xlsx` now includes the Q3 figures\n- `notes.md` summarises the changes for the board\n- `app.ts` has the new export format\n\n### Please check\n\nThe totals in the workbook. Everything else is routine.",
  files: [
    { path: abs("sales.xlsx"), sha256: sha(join(files, "sales.xlsx")), role: "modified" },
    { path: abs("notes.md"), sha256: sha(join(files, "notes.md")), role: "created" },
    { path: abs("app.ts"), sha256: sha(join(files, "app.ts")), role: "modified" },
  ],
  checks: [
    { name: "Totals match the ledger", status: "pass", evidence: "Q3 total 1,284,500 matches the ledger export." },
    { name: "Workbook opens without errors", status: "pass" },
    { name: "Style check", status: "skip", evidence: "Not run in this demo." },
  ],
  sources: [{ title: "Q3 ledger export", ref: "ledger-q3.csv" }],
  view: join(here, "status.uview.json").replace(/\\/g, "/"),
};

const view = {
  uniview: "view/1",
  title: "Quarterly sales pack: status",
  agent: { name: "Demo assistant", model: "example-model" },
  body: [
    { type: "heading", text: "Quarterly sales pack", level: 1 },
    { type: "callout", tone: "success", title: "Ready for review", text: "Three files updated; all checks passed." },
    {
      type: "table",
      columns: [
        { key: "file", label: "File" },
        { key: "change", label: "Change" },
        { key: "status", label: "Status" },
      ],
      rows: [
        { file: "sales.xlsx", change: "Added Q3 figures", status: "Updated" },
        { file: "notes.md", change: "Board summary", status: "New" },
        { file: "app.ts", change: "New export format", status: "Updated" },
      ],
    },
    {
      type: "chart",
      kind: "bar",
      x: ["Q1", "Q2", "Q3"],
      series: [{ name: "Revenue (thousands)", values: [940, 1105, 1284] }],
    },
    { type: "diff", unified: "@@ -1,2 +1,2 @@\n-export format: csv\n+export format: xlsx\n total: 1,284,500\n" },
  ],
};

// A decision file from a previous demo run would make the new decision report "not saved": start clean.
rmSync(resolve(here, "demo-review.receipt.json.decision.json"), { force: true });
writeFileSync(resolve(here, "demo-review.receipt.json"), JSON.stringify(receipt, null, 2));
writeFileSync(resolve(here, "status.uview.json"), JSON.stringify(view, null, 2));
console.log("demo review written:", resolve(here, "demo-review.receipt.json"));
