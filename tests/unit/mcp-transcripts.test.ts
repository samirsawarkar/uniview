import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startServer, flush, toolCall, escapeHeavySpec, paddedLine } from "./mcp-helpers";

// Conformance transcripts: each line of fixtures/mcp/*.jsonl is either a line the
// client sends or, when it is a JSON object with "result" or "error" and no
// "method", the exact line the server must answer next. After the last line no
// further output may appear (cancelled requests and notifications get no answer).
const dir = path.resolve(__dirname, "../../fixtures/mcp");
const transcripts = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();

function isExpected(line: string): boolean {
  try {
    const v = JSON.parse(line);
    return v !== null && typeof v === "object" && !Array.isArray(v) && !("method" in v) && ("result" in v || "error" in v);
  } catch {
    return false;
  }
}

describe("MCP conformance transcripts", () => {
  it("covers every supported revision, the lifecycle and cancellation", () => {
    // Mutation: deleting a transcript file silently drops its conformance cases.
    expect(transcripts).toEqual([
      "cancel.jsonl",
      "lifecycle.jsonl",
      "negotiate.jsonl",
      "tools-2024-11-05.jsonl",
      "tools-2025-03-26.jsonl",
      "tools-2025-06-18.jsonl",
    ]);
  });

  it("every tool error code appears in some transcript", () => {
    // Mutation: an error code whose envelope is never pinned by a transcript.
    const all = transcripts.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
    for (const code of ["not_allowed", "bad_path", "invalid_spec", "invalid_receipt", "busy", "app_unavailable", "not_found", "timeout"]) {
      expect(all).toContain(`"text":"${code}: `);
    }
  });

  for (const file of transcripts) {
    it(`replays ${file}`, async () => {
      // Mutation: any change to message shapes, key order, codes, envelopes or lifecycle rules.
      const lines = fs.readFileSync(path.join(dir, file), "utf8").split(/\r?\n/).filter((l) => l.length > 0);
      const server = startServer();
      for (const line of lines) {
        if (isExpected(line)) {
          expect(await server.next()).toBe(line);
        } else {
          server.send(line);
          await flush();
        }
      }
      await server.end();
      await flush();
      expect(server.lines).toEqual([]);
      expect(server.partial()).toBe("");
    });
  }

  it("replays a 16 MiB escape-heavy line (accepted) and a 16 MiB + 1 line (-32600, discarded) with exact response lines", async () => {
    // Mutation: an off-by-one line limit; accepting 16 MiB + 1; buffering an oversized line; the line after it being lost.
    const MiB = 1024 * 1024;
    const server = startServer();
    await server.initialize();
    const spec = escapeHeavySpec(2 * MiB);
    const atLimit = paddedLine(toolCall(1, "show_view", { specText: spec }), 16 * MiB);
    expect(Buffer.byteLength(atLimit)).toBe(16 * MiB);
    server.send(atLimit);
    expect(await server.next(30000)).toBe(
      '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"shown\\":true,\\"scopeId\\":\\"scope-1\\"}"}],"structuredContent":{"shown":true,"scopeId":"scope-1"}}}',
    );
    server.send(paddedLine(toolCall(2, "show_view", { specText: spec }), 16 * MiB + 1));
    server.send('{"jsonrpc":"2.0","id":3,"method":"ping"}');
    expect(await server.next(30000)).toBe('{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request: line longer than 16777216 bytes"}}');
    expect(await server.next()).toBe('{"jsonrpc":"2.0","id":3,"result":{}}');
    await server.end();
    expect(server.lines).toEqual([]);
  }, 120000);
});
