import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReceiptViewer from "../../src/viewers/ReceiptViewer";
import { LanNotFoundError, type LanReader } from "../../src/core/receipt-resolve";
import { WEB_HASH_LIMITS } from "../../src/core/receipt-verify-web";
import { sha256Hex } from "../../shared/receipt.mjs";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const enc = new TextEncoder();
const hashOf = (t: string) => sha256Hex(enc.encode(t));

function makeSource(data: object, remote?: any) {
  const bytes = enc.encode(JSON.stringify(data));
  return {
    id: "test-src",
    name: "task.receipt.json",
    size: bytes.byteLength,
    readAll: async () => bytes.buffer.slice(0),
    readRange: async (a: number, b: number) => bytes.buffer.slice(a, b),
    url: async () => "blob:test",
    release: () => {},
    remote,
  };
}

const REMOTE = { hostId: "host-1", rootId: "root-1", rootName: "Work", path: "dir/task.receipt.json", mtime: 1 };

function receiptOf(files: Array<{ path: string; relPath?: string; sha256: string }>, extra: object = {}) {
  return {
    uniview: "receipt/1",
    createdAt: "2026-10-24T12:00:00Z",
    agent: { name: "Bot" },
    task: "Check things",
    summary: "Done.",
    files: files.map((f) => ({ ...f, role: "modified" })),
    ...extra,
  };
}

interface FakeFile {
  name: string;
  size: number;
  arrayBuffer: ReturnType<typeof vi.fn>;
}
function fakeFile(name: string, text: string, size?: number): FakeFile {
  const b = enc.encode(text);
  return { name, size: size ?? b.byteLength, arrayBuffer: vi.fn(async () => b.buffer.slice(0)) };
}

/** A fake remote: files by share-relative path. Records every open and read. */
function fakeLan(files: Record<string, string | Error>, sizes: Record<string, number> = {}) {
  const opened: string[] = [];
  const reads: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const reader: LanReader = {
    open: async (p) => {
      opened.push(p);
      const v = files[p];
      if (v === undefined) throw new LanNotFoundError();
      if (v instanceof Error) throw v;
      const b = enc.encode(v);
      return {
        size: sizes[p] ?? b.byteLength,
        readAll: async () => {
          reads.push(p);
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return b.buffer.slice(0);
        },
      };
    },
  };
  return { reader, opened, reads, maxInFlight: () => maxInFlight };
}

describe("ReceiptViewer reference resolution", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function settle(ms = 40) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }

  async function waitFor(pred: () => boolean, label = "condition") {
    for (let i = 0; i < 100; i++) {
      if (pred()) return;
      await settle(10);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async function mount(source: any, props: Record<string, unknown> = {}) {
    const onOpen = vi.fn();
    await act(async () => {
      root.render(
        <ReceiptViewer
          source={source}
          detection={{ kind: "receipt" as any, ext: "receipt.json", by: "extension", label: "Review receipt" }}
          onOpen={onOpen}
          onReady={() => {}}
          {...(props as any)}
        />
      );
    });
    await waitFor(() => container.querySelector(".receipt-file-item") !== null || container.querySelector("[role=alert]") !== null, "receipt render");
    return { onOpen };
  }

  const stateOf = (i: number) =>
    container.querySelectorAll(".receipt-file-item")[i]?.querySelector(".receipt-state-badge")?.textContent;

  async function pick(files: Array<FakeFile>) {
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  const refButton = (label: string) =>
    Array.from(container.querySelectorAll(".vs-fileref-placeholder"))
      .find((el) => el.textContent!.includes(label))
      ?.querySelector("button") as HTMLButtonElement | undefined;

  const choiceButtons = () => Array.from(container.querySelectorAll(".receipt-choice-btn")) as HTMLButtonElement[];

  // ---------------------------------------------------------------- finding 1: duplicate names by hash
  describe("duplicate companion names", () => {
    it("keeps a single matching companion unchanged", async () => {
      // Mutation: not reading the picked companion at all
      const h = await hashOf("hello");
      await mount(makeSource(receiptOf([{ path: "/w/a.txt", sha256: h }])));
      await pick([fakeFile("a.txt", "hello")]);
      await waitFor(() => stateOf(0) === "unchanged", "unchanged");
    });

    it("auto-selects the hash match when a second a.txt (tampered) is picked", async () => {
      // Mutation: building companions without a sha256 so matchCompanionFile's hash tie-break never applies
      const h = await hashOf("hello");
      await mount(makeSource(receiptOf([{ path: "/w/a.txt", sha256: h }])));
      await pick([fakeFile("a.txt", "hello")]);
      await waitFor(() => stateOf(0) === "unchanged", "unchanged");
      await pick([fakeFile("a.txt", "tampered")]);
      await settle(80);
      expect(stateOf(0)).toBe("unchanged");
      expect(choiceButtons().length).toBe(0);
    });

    it("auto-selects the hash match even when the tampered duplicate was picked first", async () => {
      // Mutation: choosing the first duplicate by order instead of by hash
      const h = await hashOf("hello");
      await mount(makeSource(receiptOf([{ path: "/w/a.txt", sha256: h }])));
      await pick([fakeFile("a.txt", "tampered"), fakeFile("a.txt", "hello")]);
      await waitFor(() => stateOf(0) === "unchanged", "unchanged");
      expect(choiceButtons().length).toBe(0);
    });

    it("asks the person when two duplicates have the expected hash", async () => {
      // Mutation: silently choosing one of two equal-hash duplicates
      const h = await hashOf("hello");
      await mount(makeSource(receiptOf([{ path: "/w/a.txt", sha256: h }])));
      await pick([fakeFile("a.txt", "hello"), fakeFile("a.txt", "hello")]);
      await waitFor(() => choiceButtons().length === 2, "picker");
      expect(stateOf(0)).toBe("missing");
      await act(async () => choiceButtons()[1]!.click());
      await waitFor(() => stateOf(0) === "unchanged", "unchanged after choosing");
      expect(choiceButtons().length).toBe(0);
    });

    it("asks the person when no duplicate has the expected hash, and a chosen tampered file shows changed", async () => {
      // Mutation: auto-picking a duplicate (or marking it unchanged) when none matches the hash
      const h = await hashOf("hello");
      await mount(makeSource(receiptOf([{ path: "/w/a.txt", sha256: h }])));
      await pick([fakeFile("a.txt", "x1"), fakeFile("a.txt", "x2")]);
      await waitFor(() => choiceButtons().length === 2, "picker");
      await act(async () => choiceButtons()[0]!.click());
      await waitFor(() => stateOf(0) === "changed", "changed after choosing");
    });

    it("keeps companion ids distinct when picks happen in the same millisecond", async () => {
      // Mutation: ids built from Date.now() and the batch index collide between two picks
      vi.spyOn(Date, "now").mockReturnValue(1234);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const h = await hashOf("hello");
      await mount(makeSource(receiptOf([{ path: "/w/a.txt", sha256: h }])));
      await pick([fakeFile("a.txt", "x1")]);
      await pick([fakeFile("a.txt", "x2")]);
      await waitFor(() => choiceButtons().length === 2, "picker");
      expect(errors.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
      await act(async () => choiceButtons()[1]!.click());
      await waitFor(() => stateOf(0) === "changed", "changed");
    });
  });

  // ---------------------------------------------------------------- finding 2 + 5: LAN reads
  describe("files on the LAN root", () => {
    it("reads, hashes and reports unchanged / changed / missing / unreadable", async () => {
      // Mutation: returning null for LAN-resolved paths (always 'missing', never read)
      const lan = fakeLan({
        "dir/src/ok.txt": "hello",
        "dir/src/edited.txt": "edited",
        "dir/src/locked.txt": new Error("host stopped responding"),
      });
      const h = await hashOf("hello");
      await mount(
        makeSource(
          receiptOf([
            { path: "/w/src/ok.txt", relPath: "src/ok.txt", sha256: h },
            { path: "/w/src/edited.txt", relPath: "src/edited.txt", sha256: h },
            { path: "/w/src/gone.txt", relPath: "src/gone.txt", sha256: h },
            { path: "/w/src/locked.txt", relPath: "src/locked.txt", sha256: h },
          ]),
          REMOTE
        ),
        { lanReader: lan.reader }
      );
      await waitFor(() => stateOf(3) !== "not checked", "pass done");
      expect([0, 1, 2, 3].map(stateOf)).toEqual(["unchanged", "changed", "missing", "unreadable"]);
      expect(lan.opened).toEqual(["dir/src/ok.txt", "dir/src/edited.txt", "dir/src/gone.txt", "dir/src/locked.txt"]);
    });

    it("reads LAN files one at a time", async () => {
      // Mutation: reading LAN files concurrently
      const lan = fakeLan({ "dir/a": "a", "dir/b": "b", "dir/c": "c" });
      const h = await hashOf("a");
      await mount(
        makeSource(
          receiptOf([
            { path: "/w/a", relPath: "a", sha256: h },
            { path: "/w/b", relPath: "b", sha256: h },
            { path: "/w/c", relPath: "c", sha256: h },
          ]),
          REMOTE
        ),
        { lanReader: lan.reader }
      );
      await waitFor(() => stateOf(2) !== "not checked", "pass done");
      expect(lan.reads).toEqual(["dir/a", "dir/b", "dir/c"]);
      expect(lan.maxInFlight()).toBe(1);
    });

    it("marks a LAN file of 256 MiB + 1 byte too_large without reading it", async () => {
      // Mutation: reading LAN files before checking their size against the 256 MiB limit
      const lan = fakeLan({ "dir/big.bin": "x" }, { "dir/big.bin": WEB_HASH_LIMITS.MAX_FILE_BYTES + 1 });
      await mount(makeSource(receiptOf([{ path: "/w/big.bin", relPath: "big.bin", sha256: "a".repeat(64) }]), REMOTE), {
        lanReader: lan.reader,
      });
      await waitFor(() => stateOf(0) === "too_large", "too_large");
      expect(lan.reads).toEqual([]);
    });

    it("treats escaping, absolute and different-root references as missing and never follows them", async () => {
      // Mutation: following an escaping relPath, or falling through to a same-named picked companion
      const lan = fakeLan({ "dir/x.txt": "hello" });
      const h = await hashOf("hello");
      // relPath is also checked by the receipt validator, so exercise the resolver with values the validator allows
      // but a Windows host would misread: dots and spaces, and a name that only resolves outside via the receipt path.
      await mount(
        makeSource(
          receiptOf([
            { path: "/w/x.txt", relPath: ".. /x.txt", sha256: h },
            { path: "/w/y.txt", relPath: "... /x.txt", sha256: h },
          ]),
          { ...REMOTE, path: "receipt.receipt.json" }
        ),
        { lanReader: lan.reader }
      );
      await pick([fakeFile("x.txt", "hello")]);
      await waitFor(() => stateOf(0) !== "not checked" && stateOf(1) !== "not checked", "pass done");
      await settle(60);
      expect([stateOf(0), stateOf(1)]).toEqual(["missing", "missing"]);
      expect(lan.opened).toEqual([]);
    });

    it("does not use a picked companion for a file the LAN root resolves", async () => {
      // Mutation: preferring a same-named companion over the LAN root
      const lan = fakeLan({ "dir/a.txt": "hello" });
      const h = await hashOf("hello");
      await mount(makeSource(receiptOf([{ path: "/w/a.txt", relPath: "a.txt", sha256: h }]), REMOTE), { lanReader: lan.reader });
      await waitFor(() => stateOf(0) === "unchanged", "unchanged");
      const f = fakeFile("a.txt", "different");
      await pick([f]);
      await settle(80);
      expect(stateOf(0)).toBe("unchanged");
      expect(f.arrayBuffer).not.toHaveBeenCalled();
    });

    it("reports unreadable when the receipt came from a share but no reader can be built", async () => {
      // Mutation: reporting missing when the LAN read could not even start
      await mount(makeSource(receiptOf([{ path: "/w/a.txt", relPath: "a.txt", sha256: "a".repeat(64) }]), REMOTE), {
        lanReader: null,
      });
      await waitFor(() => stateOf(0) === "unreadable", "unreadable");
    });

    it("shows 'not checked' (not 'missing') until the LAN read finishes", async () => {
      // Mutation: defaulting every file to 'missing' before verification completes
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const reader: LanReader = {
        open: async () => {
          await gate;
          return { size: 5, readAll: async () => enc.encode("hello").buffer.slice(0) };
        },
      };
      const h = await hashOf("hello");
      await mount(makeSource(receiptOf([{ path: "/w/a.txt", relPath: "a.txt", sha256: h }]), REMOTE), { lanReader: reader });
      await settle(40);
      expect(stateOf(0)).toBe("not checked");
      release();
      await waitFor(() => stateOf(0) === "unchanged", "unchanged");
    });
  });

  // ---------------------------------------------------------------- finding 3: receipt.view, images, fileRefs
  describe("receipt.view", () => {
    const viewSpec = {
      uniview: "view/1",
      title: "Agent view",
      body: [
        { type: "image", path: "/w/img/shot.png", relPath: "img/shot.png", alt: "Screenshot" },
        { type: "fileRef", path: "/w/notes.md", relPath: "notes.md", label: "Notes" },
        { type: "fileRef", path: "/w/lost.md", relPath: "lost.md", label: "Lost" },
        { type: "fileRef", path: "/w/out.md", relPath: "... /out.md", label: "Outside" },
      ],
    };
    const viewJson = JSON.stringify(viewSpec);

    it("resolves viewRelPath on the LAN root and renders it through the view viewer", async () => {
      // Mutation: ignoring receipt.view / viewRelPath
      const lan = fakeLan({ "dir/views/v.uview.json": viewJson });
      const h = await hashOf("hello");
      await mount(
        makeSource(
          receiptOf([{ path: "/w/a.txt", relPath: "a.txt", sha256: h }], { view: "/w/views/v.uview.json", viewRelPath: "views/v.uview.json" }),
          REMOTE
        ),
        { lanReader: lan.reader }
      );
      await waitFor(() => container.textContent!.includes("Agent view"), "view title");
      expect(lan.opened).toContain("dir/views/v.uview.json");
    });

    it("shows 'image not available on this device' for unresolved images and disables unresolved fileRefs", async () => {
      // Mutation: placeholder text missing, or unresolved fileRefs left enabled
      const lan = fakeLan({ "dir/views/v.uview.json": viewJson, "dir/views/notes.md": "# notes" });
      await mount(
        makeSource(
          receiptOf([{ path: "/w/a.txt", relPath: "a.txt", sha256: "a".repeat(64) }], { view: "/w/views/v.uview.json", viewRelPath: "views/v.uview.json" }),
          REMOTE
        ),
        { lanReader: lan.reader }
      );
      await waitFor(() => container.querySelector(".agent-image-placeholder") !== null, "image placeholder");
      const placeholder = container.querySelector(".agent-image-placeholder")!;
      expect(placeholder.textContent).toContain("image not available on this device");
      // The spec's images and fileRefs are resolved against the VIEW's folder, not the receipt's.
      await waitFor(() => lan.opened.includes("dir/views/notes.md"), "fileRef lookup");
      expect(lan.opened).toContain("dir/views/img/shot.png");
      await waitFor(() => refButton("Notes") !== undefined && !refButton("Notes")!.disabled, "resolved fileRef enabled");
      await waitFor(() => refButton("Lost")!.classList.contains("agent-fileref"), "lost lookup done");
      expect(refButton("Lost")!.disabled).toBe(true);
      expect(refButton("Outside")!.disabled).toBe(true);
      // An unsafe relPath (a '..' hidden behind dots and spaces) is never even looked up.
      expect(lan.opened.some((p) => p.includes("out.md"))).toBe(false);
    });

    it("opens a resolved fileRef in a new tab through onOpen", async () => {
      // Mutation: resolved fileRefs rendered enabled but doing nothing
      const lan = fakeLan({ "dir/views/v.uview.json": viewJson, "dir/views/notes.md": "# notes" });
      const { onOpen } = await mount(
        makeSource(
          receiptOf([{ path: "/w/a.txt", relPath: "a.txt", sha256: "a".repeat(64) }], { view: "/w/views/v.uview.json", viewRelPath: "views/v.uview.json" }),
          REMOTE
        ),
        { lanReader: lan.reader }
      );
      await waitFor(() => !!refButton("Notes") && !refButton("Notes")!.disabled, "enabled fileRef");
      await act(async () => refButton("Notes")!.click());
      expect(onOpen).toHaveBeenCalledTimes(1);
      const opened = onOpen.mock.calls[0]![0] as any[];
      expect(opened[0].name).toBe("notes.md");
      expect(new TextDecoder().decode(await opened[0].readAll())).toBe("# notes");
    });

    it("resolves the view from a picked companion when the receipt is not on a share", async () => {
      // Mutation: only resolving the view through the LAN root
      await mount(makeSource(receiptOf([{ path: "/w/a.txt", sha256: "a".repeat(64) }], { view: "/w/views/v.uview.json" })));
      expect(container.textContent).toContain("The view is not available on this device");
      const f = fakeFile("v.uview.json", viewJson);
      await pick([f]);
      await waitFor(() => container.textContent!.includes("Agent view"), "view title");
      // No share, no companion for the images: placeholders and disabled refs.
      await waitFor(() => container.querySelector(".agent-image-placeholder") !== null, "image placeholder");
      await waitFor(() => refButton("Notes")?.classList.contains("agent-fileref") === true, "fileRef lookup done");
      expect(refButton("Notes")!.disabled).toBe(true);
    });

    it("lets a picked companion resolve a fileRef inside a companion-resolved view", async () => {
      // Mutation: companions ignored for references inside the view
      await mount(makeSource(receiptOf([{ path: "/w/a.txt", sha256: "a".repeat(64) }], { view: "/w/views/v.uview.json" })));
      await pick([fakeFile("v.uview.json", viewJson), fakeFile("notes.md", "# n")]);
      await waitFor(() => !!refButton("Notes") && !refButton("Notes")!.disabled, "enabled fileRef");
    });

    it("shows the view as missing when the share does not have it", async () => {
      // Mutation: crashing or showing nothing when the view file is absent on the share
      const lan = fakeLan({});
      await mount(
        makeSource(
          receiptOf([{ path: "/w/a.txt", relPath: "a.txt", sha256: "a".repeat(64) }], { view: "/w/v.uview.json", viewRelPath: "v.uview.json" }),
          REMOTE
        ),
        { lanReader: lan.reader }
      );
      await waitFor(() => container.textContent!.includes("The view is not available on this device"), "view missing note");
    });
  });

  // ---------------------------------------------------------------- finding 4: bounded memory, serial passes
  describe("companion handles and passes", () => {
    it("does not read picked files at pick time and reads a matched one only when hashing", async () => {
      // Mutation: reading every picked file fully into memory in the change handler
      const h = await hashOf("hello");
      await mount(makeSource(receiptOf([{ path: "/w/a.txt", sha256: h }])));
      const used = fakeFile("a.txt", "hello");
      const unused = fakeFile("unrelated.bin", "zzz");
      await pick([used, unused]);
      await waitFor(() => stateOf(0) === "unchanged", "unchanged");
      expect(unused.arrayBuffer).not.toHaveBeenCalled();
      expect(used.arrayBuffer).toHaveBeenCalledTimes(1);
    });

    it("marks a picked file of 256 MiB + 1 byte too_large without reading it", async () => {
      // Mutation: reading a picked file before checking file.size against 256 MiB
      await mount(makeSource(receiptOf([{ path: "/w/big.bin", sha256: "a".repeat(64) }])));
      const big = fakeFile("big.bin", "x", WEB_HASH_LIMITS.MAX_FILE_BYTES + 1);
      await pick([big]);
      await waitFor(() => stateOf(0) === "too_large", "too_large");
      expect(big.arrayBuffer).not.toHaveBeenCalled();
    });

    it("hashes a picked file of exactly 256 MiB (limit, not limit+1)", async () => {
      // Mutation: rejecting a picked file at exactly 256 MiB
      await mount(makeSource(receiptOf([{ path: "/w/big.bin", sha256: "a".repeat(64) }])));
      const exact = fakeFile("big.bin", "x", WEB_HASH_LIMITS.MAX_FILE_BYTES);
      exact.arrayBuffer.mockImplementation(async () => new ArrayBuffer(0));
      await pick([exact]);
      await waitFor(() => stateOf(0) === "changed", "hashed");
      expect(exact.arrayBuffer).toHaveBeenCalledTimes(1);
    });

    it("never hashes two files at once even when picks overlap an in-flight pass", async () => {
      // Mutation: starting a new verification pass without waiting for the in-flight one
      const h = await hashOf("a");
      await mount(makeSource(receiptOf([{ path: "/w/a.txt", sha256: h }, { path: "/w/b.txt", sha256: h }])));
      let inFlight = 0;
      let max = 0;
      const gates: Array<() => void> = [];
      const slow = (name: string, text: string): FakeFile => {
        const f = fakeFile(name, text);
        f.arrayBuffer.mockImplementation(async () => {
          inFlight++;
          max = Math.max(max, inFlight);
          await new Promise<void>((r) => gates.push(r));
          inFlight--;
          return enc.encode(text).buffer.slice(0);
        });
        return f;
      };
      await pick([slow("a.txt", "a")]);
      await waitFor(() => gates.length === 1, "first read started");
      await pick([slow("b.txt", "a")]); // new pass requested while the first read is still pending
      await settle(40);
      expect(max).toBe(1);
      // Let reads finish one by one until the queue drains.
      for (let i = 0; i < 6; i++) {
        const g = gates.shift();
        if (g) g();
        await settle(20);
      }
      await waitFor(() => stateOf(0) === "unchanged" && stateOf(1) === "unchanged", "both unchanged");
      expect(max).toBe(1);
    });

    it("stops reading the remaining files when the viewer is unmounted mid-pass", async () => {
      // Mutation: not aborting the in-flight pass on cleanup
      const h = await hashOf("a");
      await mount(makeSource(receiptOf([{ path: "/w/a.txt", sha256: h }, { path: "/w/b.txt", sha256: h }, { path: "/w/c.txt", sha256: h }])));
      let release!: () => void;
      const a = fakeFile("a.txt", "a");
      a.arrayBuffer.mockImplementation(() => new Promise<ArrayBuffer>((r) => (release = () => r(enc.encode("a").buffer.slice(0)))));
      const b = fakeFile("b.txt", "a");
      const c = fakeFile("c.txt", "a");
      await pick([a, b, c]);
      await waitFor(() => a.arrayBuffer.mock.calls.length === 1, "a read started");
      act(() => root.unmount());
      release();
      await settle(60);
      expect(b.arrayBuffer).not.toHaveBeenCalled();
      expect(c.arrayBuffer).not.toHaveBeenCalled();
      root = createRoot(container);
    });
  });

  // ---------------------------------------------------------------- finding 7: sanitising
  describe("agent text", () => {
    it("strips control and bidirectional characters from task, paths, check names, sources and evidence", async () => {
      // Mutation: rendering task / file paths / check names / source titles / refs / evidence raw
      const evil = "‮gpj.exe‬";
      const data = receiptOf([{ path: "/w/a‮txt.exe", relPath: "dir/⁦x⁩\u0007.txt", sha256: "a".repeat(64) }], {
        task: `Task ${evil}\u0000 end`,
        checks: [{ name: `check ${evil}`, status: "pass", evidence: `line1\nline2 ${evil}\u0007` }],
        sources: [{ title: `title ${evil}`, ref: `https://x.example/${evil}` }],
      });
      await mount(makeSource(data));
      const text = container.textContent!;
      expect(text).toContain("Task");
      expect(text).toContain("line1");
      expect(text).toContain("line2");
      expect(/[‪-‮⁦-⁩\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)).toBe(false);
      expect(container.querySelector(".receipt-check-evidence")!.textContent).toContain("line1\nline2");
    });

    it("sanitises picked file names shown in the chooser", async () => {
      // Mutation: showing raw picked file names in the chooser buttons
      const name = "a‮txt.exe";
      await mount(makeSource(receiptOf([{ path: `/w/${name}`, sha256: "a".repeat(64) }])));
      await pick([fakeFile(name, "1"), fakeFile(name, "2")]);
      await waitFor(() => choiceButtons().length === 2, "picker");
      expect(/[‪-‮]/.test(choiceButtons()[0]!.textContent!)).toBe(false);
      expect(container.querySelector(".receipt-ambiguous-prompt")!.textContent!.includes("‮")).toBe(false);
    });
  });
});
