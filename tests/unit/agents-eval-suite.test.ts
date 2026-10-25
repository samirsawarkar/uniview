import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error plain ESM module without types
import { parseArgs } from "../../electron/lib/cli.mjs";

interface EvalCase {
  name: string;
  args: string[];
  input?: string;
  expect: {
    exit_code: number;
    contains?: string[];
    not_contains?: string[];
    regex?: string;
    json_keys?: string[];
  };
}

interface EvalSuite {
  command: string[];
  cases: EvalCase[];
}

function matchesGlob(filePath: string, pattern: string): boolean {
  const normPath = filePath.replace(/\\/g, "/");
  const normPat = pattern.replace(/\\/g, "/");
  const regexStr = normPat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/\*/g, "___GLOB_STAR_STAR_STAR___")
    .replace(/\*\*/g, "___GLOB_STAR_STAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___GLOB_STAR_STAR_STAR___/g, ".*")
    .replace(/___GLOB_STAR_STAR___/g, ".*");
  return new RegExp(`^${regexStr}$`).test(normPath);
}

function isCovered(filePath: string, patterns: string[]): boolean {
  let covered = false;
  for (const pat of patterns) {
    if (pat.startsWith("!")) {
      if (matchesGlob(filePath, pat.slice(1))) {
        covered = false;
      }
    } else {
      if (matchesGlob(filePath, pat)) {
        covered = true;
      }
    }
  }
  return covered;
}

function getAllFilesRecursively(dir: string, baseDir: string = dir): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllFilesRecursively(fullPath, baseDir));
    } else if (entry.isFile()) {
      results.push(path.relative(baseDir, fullPath).replace(/\\/g, "/"));
    }
  }
  return results;
}

function validateSuiteShape(suite: EvalSuite, minCases: number) {
  expect(Array.isArray(suite.command), "command must be an array").toBe(true);
  expect(suite.command.length, "command must not be empty").toBeGreaterThan(0);
  for (const c of suite.command) {
    expect(typeof c).toBe("string");
    expect(c.length).toBeGreaterThan(0);
  }

  expect(Array.isArray(suite.cases), "cases must be an array").toBe(true);
  expect(suite.cases.length, `cases must contain at least ${minCases} test cases`).toBeGreaterThanOrEqual(minCases);

  for (const c of suite.cases) {
    expect(typeof c.name, `case ${c.name} must have a name string`).toBe("string");
    expect(c.name.trim().length, `case ${c.name} name must not be empty`).toBeGreaterThan(0);

    expect(Array.isArray(c.args), `case ${c.name} args must be an array`).toBe(true);
    for (const a of c.args) {
      expect(typeof a, `case ${c.name} arg must be string`).toBe("string");
    }

    if (c.input !== undefined) {
      expect(typeof c.input, `case ${c.name} input must be a string`).toBe("string");
    }

    expect(typeof c.expect, `case ${c.name} must have expect object`).toBe("object");
    expect(c.expect !== null).toBe(true);
    expect(Number.isInteger(c.expect.exit_code), `case ${c.name} exit_code must be integer`).toBe(true);

    if (c.expect.contains !== undefined) {
      expect(Array.isArray(c.expect.contains), `case ${c.name} contains must be an array`).toBe(true);
      for (const s of c.expect.contains) {
        expect(typeof s).toBe("string");
      }
    }
    if (c.expect.not_contains !== undefined) {
      expect(Array.isArray(c.expect.not_contains), `case ${c.name} not_contains must be an array`).toBe(true);
      for (const s of c.expect.not_contains) {
        expect(typeof s).toBe("string");
      }
    }
    if (c.expect.regex !== undefined) {
      expect(typeof c.expect.regex, `case ${c.name} regex must be string`).toBe("string");
    }
    if (c.expect.json_keys !== undefined) {
      expect(Array.isArray(c.expect.json_keys), `case ${c.name} json_keys must be an array`).toBe(true);
      for (const k of c.expect.json_keys) {
        expect(typeof k).toBe("string");
      }
    }
  }
}

describe("P18/P25 installed-build eval suite (evals/agents.json and evals/agents-mcp.json)", () => {
  const rootDir = path.resolve(__dirname, "../..");
  const suitePath = path.join(rootDir, "evals", "agents.json");
  const mcpSuitePath = path.join(rootDir, "evals", "agents-mcp.json");

  it("evals/agents.json exists and has valid aes eval suite shape for CLI cases", () => {
    expect(fs.existsSync(suitePath), "evals/agents.json must exist").toBe(true);
    const content = fs.readFileSync(suitePath, "utf8");
    const suite: EvalSuite = JSON.parse(content);
    validateSuiteShape(suite, 4);

    expect(suite.command).toEqual(["UniView.exe"]);

    // Disallowed in packaged exe suite because no-args starts GUI and unknown arg opens file
    expect(suite.cases.some((c) => c.name === "usage error missing command")).toBe(false);
    expect(suite.cases.some((c) => c.name === "usage error unknown command")).toBe(false);

    // MCP cases moved to agents-mcp.json
    expect(suite.cases.some((c) => c.args.includes("--mcp"))).toBe(false);
  });

  it("evals/agents-mcp.json exists and has valid shape with placeholder launcher command", () => {
    expect(fs.existsSync(mcpSuitePath), "evals/agents-mcp.json must exist").toBe(true);
    const content = fs.readFileSync(mcpSuitePath, "utf8");
    const suite: EvalSuite = JSON.parse(content);
    validateSuiteShape(suite, 3);

    expect(suite.command).toEqual(["cmd", "/c", "<install>\\resources\\uniview-mcp.cmd"]);

    const hasMcpTranscript = suite.cases.some(
      (c) =>
        c.input?.includes("initialize") &&
        c.input?.includes("tools/list") &&
        c.expect.exit_code === 0 &&
        c.expect.contains?.some((sub) => sub.includes("tools"))
    );
    expect(hasMcpTranscript, "MCP suite must include initialize + tools/list transcript case").toBe(true);

    const hasSpecError = suite.cases.some(
      (c) =>
        c.input?.includes("show_view") &&
        c.expect.contains?.some((sub) => sub.includes("invalid_spec"))
    );
    expect(hasSpecError, "MCP suite must include invalid_spec case").toBe(true);

    const hasReceiptError = suite.cases.some(
      (c) =>
        c.input?.includes("request_review") &&
        c.expect.contains?.some((sub) => sub.includes("invalid_receipt"))
    );
    expect(hasReceiptError, "MCP suite must include invalid_receipt case").toBe(true);
  });

  it("every args flag used in CLI cases is accepted by cli.mjs parseArgs without drift", () => {
    expect(fs.existsSync(suitePath)).toBe(true);
    const suite: EvalSuite = JSON.parse(fs.readFileSync(suitePath, "utf8"));
    const cwd = rootDir;

    const allowedCliFlags = new Set(["--wait", "--receipt", "--view", "--timeout", "--"]);

    for (const c of suite.cases) {
      if (c.args.includes("--mcp")) {
        continue;
      }

      if (c.args.length === 0) {
        const parsed = parseArgs(c.args, cwd);
        expect(parsed.ok).toBe(false);
        expect(parsed.error).toMatch(/missing command/);
        continue;
      }

      if (c.args[0] === "open") {
        let afterDoubleDash = false;
        for (let i = 1; i < c.args.length; i++) {
          const arg = c.args[i];
          if (arg === undefined) continue;
          if (arg === "--") {
            afterDoubleDash = true;
            continue;
          }
          if (!afterDoubleDash && arg.startsWith("-")) {
            const flag = arg.split("=")[0] ?? "";
            expect(
              allowedCliFlags.has(flag),
              `Flag '${flag}' in case '${c.name}' must be one of accepted flags: ${Array.from(allowedCliFlags).join(", ")}`
            ).toBe(true);
          }
        }

        const parsed = parseArgs(c.args, cwd);
        if (!parsed.ok) {
          expect(
            parsed.error,
            `Case '${c.name}' failed parseArgs with unknown option: ${parsed.error}`
          ).not.toMatch(/unknown option/);
        }
      }
    }
  });

  it("covers required P18 golden CLI cases: open ack and open usage errors", () => {
    expect(fs.existsSync(suitePath)).toBe(true);
    const suite: EvalSuite = JSON.parse(fs.readFileSync(suitePath, "utf8"));

    const hasOpenAck = suite.cases.some(
      (c) =>
        c.args[0] === "open" &&
        c.expect.exit_code === 0 &&
        c.expect.contains?.some((sub) => sub.includes("Opened in UniView:"))
    );
    expect(hasOpenAck, "suite must include an open acknowledgement case").toBe(true);

    const usageCases = suite.cases.filter((c) => c.expect.exit_code === 2 && c.args[0] === "open");
    expect(usageCases.length, "suite must include open usage-error exit code (2) cases").toBeGreaterThanOrEqual(2);
  });
});

describe("P18/P25 packaging verification (electron-builder.json)", () => {
  const rootDir = path.resolve(__dirname, "../..");
  const builderPath = path.join(rootDir, "electron-builder.json");

  it("electron-builder.json includes electron/mcp-entry.mjs, electron/lib/*.mjs, shared/**, and extraResources launcher", () => {
    expect(fs.existsSync(builderPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(builderPath, "utf8"));
    const files = config.files;
    expect(Array.isArray(files), "electron-builder.json must have 'files' array").toBe(true);

    // Verify electron/mcp-entry.mjs is covered
    expect(isCovered("electron/mcp-entry.mjs", files), "files glob must cover electron/mcp-entry.mjs").toBe(true);

    // Verify electron/lib/*.mjs
    const libDir = path.join(rootDir, "electron", "lib");
    const libEntries = fs.readdirSync(libDir).filter((f) => f.endsWith(".mjs"));
    expect(libEntries.length, "electron/lib must have .mjs files").toBeGreaterThan(0);

    for (const file of libEntries) {
      const relPath = `electron/lib/${file}`;
      expect(
        isCovered(relPath, files),
        `electron-builder.json files must cover ${relPath}`
      ).toBe(true);
    }

    // Verify shared/**
    const sharedDir = path.join(rootDir, "shared");
    const sharedFiles = getAllFilesRecursively(sharedDir);
    expect(sharedFiles.length, "shared/ must contain files").toBeGreaterThan(0);

    for (const file of sharedFiles) {
      const relPath = `shared/${file}`;
      expect(
        isCovered(relPath, files),
        `electron-builder.json files must cover ${relPath}`
      ).toBe(true);
    }

    // Verify extraResources contains uniview-mcp.cmd
    expect(Array.isArray(config.extraResources), "electron-builder.json must have 'extraResources' array").toBe(true);
    const hasLauncher = config.extraResources.some((res: any) => {
      if (typeof res === "string") return res.includes("uniview-mcp.cmd");
      return (res?.from?.includes("uniview-mcp.cmd") || res?.to?.includes("uniview-mcp.cmd"));
    });
    expect(hasLauncher, "extraResources must package uniview-mcp.cmd launcher").toBe(true);

    // Verify build/uniview-mcp.cmd exists on disk
    const launcherSource = path.join(rootDir, "build", "uniview-mcp.cmd");
    expect(fs.existsSync(launcherSource), "build/uniview-mcp.cmd must exist").toBe(true);
  });

  it("README.md links to docs/AGENTS.md and docs/AGENTS.md exists", () => {
    const readmePath = path.join(rootDir, "README.md");
    expect(fs.existsSync(readmePath)).toBe(true);
    const readme = fs.readFileSync(readmePath, "utf8");
    expect(readme).toMatch(/docs\/AGENTS\.md/);

    const agentsDocPath = path.join(rootDir, "docs", "AGENTS.md");
    expect(fs.existsSync(agentsDocPath), "docs/AGENTS.md must exist").toBe(true);
  });
});
