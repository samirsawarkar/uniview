import { describe, it, expect } from "vitest";
import { makeHost, newSession, specJson } from "./agent-host-helpers";

describe("agent host: view.show", () => {
  it("an inline spec (raw body) opens a view tab and returns its scopeId; the UI gets the exact bytes", async () => {
    // Mutation: dropping the body, returning no scope, or re-serialising the spec instead of keeping the snapshot bytes
    const t = await makeHost();
    const s = newSession();
    const text = `{ "uniview": "view/1",\r\n "title": "Té", "body": [{"type":"heading","text":"Hello"}] }`;
    const { scopeId } = await t.call(s, "view.show", { inline: true }, Buffer.from(text));
    expect(scopeId).toMatch(/^[0-9a-f]{32}$/);
    const shown = t.ui.calls.showView[0];
    expect(shown.scopeId).toBe(scopeId);
    expect(Buffer.from(shown.specBytes).toString("utf8")).toBe(text);
    expect(shown.spec.title).toBe("Té");
    expect(shown.sessionId).toBe(s.sessionId);
  });

  it("a spec path is read through the path policy and its handle is closed again", async () => {
    // Mutation: reading by name instead of through the policy, or leaking the handle
    const t = await makeHost();
    t.fakeFs.set("/w/v.uview.json", specJson());
    const { scopeId } = await t.call(newSession(), "view.show", { path: "/w/v.uview.json" });
    expect(t.ui.calls.showView[0].scopeId).toBe(scopeId);
    expect(Buffer.from(t.ui.calls.showView[0].specBytes).toString("utf8")).toBe(specJson());
    expect(t.fakeFs.state.live).toBe(0);
  });

  it("exactly one of path or inline+body: both, neither, empty body, or a non-string path is bad_request", async () => {
    // Mutation: accepting ambiguous or empty sources
    const t = await makeHost();
    const s = newSession();
    t.fakeFs.set("/w/v.uview.json", specJson());
    const body = Buffer.from(specJson());
    expect(await t.fail(s, "view.show", { path: "/w/v.uview.json", inline: true }, body)).toBe("bad_request");
    expect(await t.fail(s, "view.show", {})).toBe("bad_request");
    expect(await t.fail(s, "view.show", { inline: true })).toBe("bad_request");
    expect(await t.fail(s, "view.show", { inline: true }, Buffer.alloc(0))).toBe("bad_request");
    expect(await t.fail(s, "view.show", { inline: "yes" }, body)).toBe("bad_request");
    expect(await t.fail(s, "view.show", { path: 5 })).toBe("bad_request");
    expect(await t.fail(s, "view.show", { path: "" })).toBe("bad_request");
    expect(t.ui.calls.showView).toEqual([]);
  });

  it("an invalid spec (bad JSON, bad UTF-8, wrong schema, an oversized file) is invalid_spec and costs no tab or quota", async () => {
    // Mutation: showing an invalid spec, mapping to the wrong code, or counting the failure against the minute
    const t = await makeHost();
    const s = newSession();
    const bad = async (body: Buffer) => t.fail(s, "view.show", { inline: true }, body);
    expect(await bad(Buffer.from("{nope"))).toBe("invalid_spec");
    expect(await bad(Buffer.from([0x7b, 0xff, 0x7d]))).toBe("invalid_spec");
    // Otherwise valid JSON with one bad byte inside a string: a lenient decoder would repair it and show a changed title.
    expect(await bad(Buffer.concat([Buffer.from('{"uniview":"view/1","title":"T'), Buffer.from([0xff]), Buffer.from('","body":[]}')]))).toBe("invalid_spec");
    expect(await bad(Buffer.from(JSON.stringify({ uniview: "view/1", title: "T", body: [{ type: "bogus" }] })))).toBe("invalid_spec");
    expect(await bad(Buffer.from(JSON.stringify({ uniview: "view/2", title: "T", body: [] })))).toBe("invalid_spec");
    t.fakeFs.set("/w/big.uview.json", Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    expect(await t.fail(s, "view.show", { path: "/w/big.uview.json" })).toBe("invalid_spec");
    expect(t.fakeFs.state.live).toBe(0);
    expect(t.ui.calls.showView).toEqual([]);
    for (let i = 0; i < 30; i++) await t.call(s, "view.show", { inline: true }, Buffer.from(specJson()));
  });

  it("limit: a spec file of exactly 2 MiB is read, 2 MiB + 1 is refused", async () => {
    // Mutation: document cap off by one in the reader
    const t = await makeHost();
    // Valid JSON padded with whitespace to the exact size (a real markdown node is limited to 256 KiB).
    const base = '{"uniview":"view/1","title":"T","body":[]}';
    const padded = (n: number) => base + " ".repeat(n - base.length);
    t.fakeFs.set("/w/ok.uview.json", padded(2 * 1024 * 1024));
    t.fakeFs.set("/w/over.uview.json", padded(2 * 1024 * 1024 + 1));
    const s = newSession();
    await expect(t.call(s, "view.show", { path: "/w/ok.uview.json" })).resolves.toHaveProperty("scopeId");
    expect(await t.fail(s, "view.show", { path: "/w/over.uview.json" })).toBe("invalid_spec");
  });

  it("a refused or missing spec path is bad_path", async () => {
    // Mutation: reporting a path-policy refusal as a spec problem (or crashing)
    const t = await makeHost();
    t.fakeFs.refuse("/w/net.uview.json");
    expect(await t.fail(newSession(), "view.show", { path: "/w/net.uview.json" })).toBe("bad_path");
    expect(await t.fail(newSession(), "view.show", { path: "/w/missing.uview.json" })).toBe("bad_path");
  });

  it("a view tab counts as an opened tab (30 per minute)", async () => {
    // Mutation: views escaping the tab rate limit
    const t = await makeHost();
    const s = newSession();
    for (let i = 0; i < 30; i++) await t.call(s, "view.show", { inline: true }, Buffer.from(specJson()));
    expect(await t.fail(s, "view.show", { inline: true }, Buffer.from(specJson()))).toBe("busy");
  });

  it("a UI failure removes the view again", async () => {
    // Mutation: leaving a scope and a tab slot behind
    const t = await makeHost();
    const s = newSession();
    t.ui.failWith = { code: "busy" };
    expect(await t.fail(s, "view.show", { inline: true }, Buffer.from(specJson()))).toBe("busy");
    t.ui.failWith = null;
    for (let i = 0; i < 30; i++) await t.call(s, "view.show", { inline: true }, Buffer.from(specJson()));
  });

  it("a UI failure leaves no tab behind under the 64-tab limit", async () => {
    // Mutation: a failed view still occupying one of the 64 slots
    const t = await makeHost();
    t.ui.failWith = { code: "busy" };
    expect(await t.fail(newSession(), "view.show", { inline: true }, Buffer.from(specJson()))).toBe("busy");
    t.ui.failWith = null;
    for (let i = 0; i < 4; i++) {
      const s = newSession();
      for (let k = 0; k < 16; k++) await t.call(s, "view.show", { inline: true }, Buffer.from(specJson()));
    }
    expect(t.ui.calls.showView).toHaveLength(64);
  });
});

describe("agent host: grants for the images and file references of a view", () => {
  const images = ["/w/a.png", "/w/b.png"];
  const viewWithImages = () =>
    JSON.stringify({
      uniview: "view/1",
      title: "T",
      body: [
        { type: "image", path: images[0], alt: "a" },
        { type: "section", children: [{ type: "columns", columns: [[{ type: "fileRef", path: "/w/doc.txt" }], [{ type: "image", path: images[1], alt: "b" }]] }] },
      ],
    });

  async function withView() {
    const t = await makeHost();
    for (const p of [...images, "/w/doc.txt", "/w/secret.txt"]) t.fakeFs.set(p, `content of ${p}`);
    const s = newSession();
    // A decoy tab first, so a grant filed under "the first tab" instead of the right scope is caught.
    await t.call(newSession(), "view.show", { inline: true }, Buffer.from(specJson()));
    const { scopeId } = await t.call(s, "view.show", { inline: true }, Buffer.from(viewWithImages()));
    return { t, s, scopeId };
  }

  it("only paths the spec itself names (images and fileRefs, nested) can be granted in its scope", async () => {
    // Mutation: granting any path (a view could then read arbitrary files), or missing nested nodes
    const { t, scopeId } = await withView();
    for (const p of [...images, "/w/doc.txt"]) await expect(t.host.viewGrant(scopeId, p)).resolves.toMatchObject({ canonical: p });
    await expect(t.host.viewGrant(scopeId, "/w/secret.txt")).rejects.toMatchObject({ code: "bad_path" });
    await expect(t.host.viewGrant(scopeId, 5 as unknown as string)).rejects.toMatchObject({ code: "bad_path" });
  });

  it("a grant reads through the held handle and is bound to that view's scope only", async () => {
    // Mutation: a token valid in another view's scope, or a grant that reopens by name
    const { t, scopeId } = await withView();
    const other = await t.call(newSession(), "view.show", { inline: true }, Buffer.from(specJson()));
    const g = await t.host.viewGrant(scopeId, images[0]!);
    expect(g).toMatchObject({ name: "a.png", size: `content of ${images[0]}`.length });
    const entry = t.host.grants.get(g.token, scopeId);
    const buf = Buffer.alloc(g.size);
    await entry.handle.read(buf, 0, g.size, 0);
    expect(buf.toString()).toBe(`content of ${images[0]}`);
    expect(t.host.grants.get(g.token, other.scopeId)).toBeUndefined();
    await expect(t.host.viewGrant(other.scopeId, images[0]!)).rejects.toMatchObject({ code: "bad_path" });
  });

  it("asking twice for the same path reuses the grant (one handle)", async () => {
    // Mutation: a new handle per request (a scrolling view would exhaust the 256 handles)
    const { t, scopeId } = await withView();
    const a = await t.host.viewGrant(scopeId, images[0]!);
    const b = await t.host.viewGrant(scopeId, images[0]!);
    expect(b.token).toBe(a.token);
    expect(t.fakeFs.state.live).toBe(1);
  });

  it("closing the view's tab closes its handles and revokes its tokens; later requests are not_found", async () => {
    // Mutation: handles outliving their tab
    const { t, scopeId } = await withView();
    const g = await t.host.viewGrant(scopeId, images[0]!);
    await t.host.tabClosed(scopeId);
    expect(t.fakeFs.state.live).toBe(0);
    expect(t.host.grants.get(g.token, scopeId)).toBeUndefined();
    await expect(t.host.viewGrant(scopeId, images[0]!)).rejects.toMatchObject({ code: "not_found" });
  });

  it("a path the policy refuses is bad_path; a file tab (no spec) has nothing to grant", async () => {
    // Mutation: bypassing the path policy for view assets
    const { t, scopeId } = await withView();
    t.fakeFs.refuse(images[1]!);
    await expect(t.host.viewGrant(scopeId, images[1]!)).rejects.toMatchObject({ code: "bad_path" });
    t.fakeFs.set("/w/a.txt", "x");
    await t.open(newSession(), ["/w/a.txt"]);
    await expect(t.host.viewGrant(t.ui.calls.openFile[0].scopeId, "/w/a.txt")).rejects.toMatchObject({ code: "not_found" });
  });

  it("closing the tab while a grant is being opened closes the new handle", async () => {
    // Mutation: a handle leaked by a close/grant race
    const { t, scopeId } = await withView();
    const pending = t.host.viewGrant(scopeId, images[0]!);
    await t.host.tabClosed(scopeId);
    await expect(pending).rejects.toMatchObject({ code: "not_found" });
    expect(t.fakeFs.state.live).toBe(0);
  });
});
