import { describe, it, expect } from "vitest";
import { flush, makeHost, newSession, receiptJson, sha256, specJson } from "./agent-host-helpers";

type T = Awaited<ReturnType<typeof makeHost>>;
type S = ReturnType<typeof newSession>;

/** Opens a review of one fake file; returns ids and the receipt text. */
async function openOne(t: T, s: S, content = "v1", file = "/w/f.txt", extra: Record<string, unknown> = {}) {
  t.fakeFs.set(file, content);
  const text = receiptJson([{ path: file, sha256: sha256(content) }], extra);
  const { reviewId } = await t.call(s, "review.open", { inline: true }, Buffer.from(text));
  return { reviewId: reviewId as string, text };
}

describe("agent host: review.open", () => {
  it("an inline receipt opens a review tab; the digest is the SHA-256 of the exact body bytes (CRLF, non-ASCII)", async () => {
    // Mutation: hashing the parsed/re-serialised receipt or a decoded string instead of the received bytes
    const t = await makeHost();
    t.fakeFs.set("/w/f.txt", "v1");
    const s = newSession();
    const text = receiptJson([{ path: "/w/f.txt", sha256: sha256("v1") }], { summary: "café ✓\r\nline two" }).replace(/,"/g, ',\r\n  "');
    const bytes = Buffer.from(text, "utf8");
    const { reviewId } = await t.call(s, "review.open", { inline: true }, bytes);
    expect(reviewId).toMatch(/^[0-9a-f]{32}$/);
    const shown = t.ui.calls.showReview[0];
    expect(shown).toMatchObject({ reviewId, receiptDigest: sha256(bytes), sessionId: s.sessionId, view: null, agent: "command line" });
    expect(Buffer.from(shown.receiptBytes).equals(bytes)).toBe(true);
    expect(shown.receipt.agent.name).toBe("test-agent");
    expect(t.host.getReview(reviewId)).toMatchObject({ reviewId, receiptDigest: sha256(bytes), decision: null, shown: null, sessionId: s.sessionId });
  });

  it("a receipt path is read through the path policy (handle closed); each review gets its own random id", async () => {
    // Mutation: reusing ids, agent-supplied ids, or leaking the handle
    const t = await makeHost();
    const text = receiptJson([{ path: "/w/f.txt", sha256: sha256("x") }]);
    t.fakeFs.set("/w/f.txt", "x");
    t.fakeFs.set("/w/r.receipt.json", text);
    const s = newSession();
    const a = await t.call(s, "review.open", { path: "/w/r.receipt.json" });
    const b = await t.call(s, "review.open", { path: "/w/r.receipt.json" });
    expect(a.reviewId).not.toBe(b.reviewId);
    expect(t.fakeFs.state.live).toBe(0);
    expect(t.ui.calls.showReview[0].receiptDigest).toBe(sha256(text));
  });

  it("exactly one source; a refused path is bad_path", async () => {
    // Mutation: ambiguous sources accepted, or path refusals reported as receipt problems
    const t = await makeHost();
    const s = newSession();
    const body = Buffer.from(receiptJson([{ path: "/w/f.txt", sha256: sha256("x") }]));
    expect(await t.fail(s, "review.open", {})).toBe("bad_request");
    expect(await t.fail(s, "review.open", { path: "/w/r.json", inline: true }, body)).toBe("bad_request");
    t.fakeFs.refuse("/w/net.json");
    expect(await t.fail(s, "review.open", { path: "/w/net.json" })).toBe("bad_path");
    expect(await t.fail(s, "review.open", { path: "/w/none.json" })).toBe("bad_path");
  });

  it("an invalid receipt (JSON, UTF-8, schema, oversized file) is invalid_receipt and costs no tab, review slot or quota", async () => {
    // Mutation: opening a review for a bad receipt, a wrong error code, or charging the failure
    const t = await makeHost();
    const s = newSession();
    const bad = (b: Buffer) => t.fail(s, "review.open", { inline: true }, b);
    expect(await bad(Buffer.from("{nope"))).toBe("invalid_receipt");
    expect(await bad(Buffer.from([0x7b, 0xff, 0x7d]))).toBe("invalid_receipt");
    expect(await bad(Buffer.from(JSON.stringify({ uniview: "receipt/1" })))).toBe("invalid_receipt");
    expect(await bad(Buffer.from(receiptJson([{ path: "relative.txt", sha256: sha256("x") }])))).toBe("invalid_receipt");
    t.fakeFs.set("/w/big.json", Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    expect(await t.fail(s, "review.open", { path: "/w/big.json" })).toBe("invalid_receipt");
    expect(t.fakeFs.state.live).toBe(0);
    expect(t.ui.calls.showReview).toEqual([]);
    for (let i = 0; i < 8; i++) await openOne(t, s, "x", `/w/f${i}.txt`);
  });

  it("limit: a receipt with 200 files opens, 201 is invalid_receipt", async () => {
    // Mutation: lifting the file cap in the host's own validation
    const t = await makeHost();
    const s = newSession();
    const files = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `/w/f${i}.txt`, sha256: sha256("x") }));
    await expect(t.call(s, "review.open", { inline: true }, Buffer.from(receiptJson(files(200))))).resolves.toHaveProperty("reviewId");
    expect(await t.fail(s, "review.open", { inline: true }, Buffer.from(receiptJson(files(201))))).toBe("invalid_receipt");
  });

  it("a UI failure removes the review and frees its slots", async () => {
    // Mutation: a phantom pending review after the renderer refused it
    const t = await makeHost();
    const s = newSession();
    t.ui.failWith = { code: "busy" };
    t.fakeFs.set("/w/f.txt", "x");
    const body = Buffer.from(receiptJson([{ path: "/w/f.txt", sha256: sha256("x") }]));
    for (let i = 0; i < 12; i++) expect(await t.fail(s, "review.open", { inline: true }, body)).toBe("busy");
    t.ui.failWith = null;
    for (let i = 0; i < 8; i++) await t.call(s, "review.open", { inline: true }, body);
    expect(t.host.listSessions()[0]!.pendingReviews).toBe(8);
  });

  it("a review tab counts against the 30 tabs per minute", async () => {
    // Mutation: reviews escaping the rate limit
    const t = await makeHost();
    const s = newSession();
    t.fakeFs.set("/w/f.txt", "x");
    const body = Buffer.from(receiptJson([{ path: "/w/f.txt", sha256: sha256("x") }]));
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 8; i++) {
        const { reviewId } = await t.call(s, "review.open", { inline: true }, body);
        await t.host.decideReview({ reviewId, decision: "dismissed" });
      }
    }
    for (let i = 0; i < 6; i++) {
      const { reviewId } = await t.call(s, "review.open", { inline: true }, body);
      await t.host.decideReview({ reviewId, decision: "dismissed" });
    }
    expect(await t.fail(s, "review.open", { inline: true }, body)).toBe("busy");
  });
});

describe("agent host: the receipt's own view", () => {
  it("a readable valid view is passed to the UI and its image paths can be granted in the review's scope", async () => {
    // Mutation: ignoring receipt.view, or granting images the view does not name
    const t = await makeHost();
    t.fakeFs.set("/w/img.png", "png");
    t.fakeFs.set("/w/other.png", "png");
    const spec = JSON.stringify({ uniview: "view/1", title: "T", body: [{ type: "image", path: "/w/img.png", alt: "a" }] });
    t.fakeFs.set("/w/v.uview.json", spec);
    const s = newSession();
    await openOne(t, s, "x", "/w/f.txt", { view: "/w/v.uview.json" });
    const shown = t.ui.calls.showReview[0];
    expect(Buffer.from(shown.view.specBytes).toString("utf8")).toBe(spec);
    expect(shown.view.spec.title).toBe("T");
    await expect(t.host.viewGrant(shown.scopeId, "/w/img.png")).resolves.toMatchObject({ name: "img.png" });
    await expect(t.host.viewGrant(shown.scopeId, "/w/other.png")).rejects.toMatchObject({ code: "bad_path" });
    expect(t.fakeFs.state.live).toBe(1);
  });

  it("an unreadable or invalid view does not fail the review; the UI is told why", async () => {
    // Mutation: failing the whole review (or crashing) because its optional view is bad
    const t = await makeHost();
    const s = newSession();
    t.fakeFs.refuse("/w/net.uview.json");
    await openOne(t, s, "x", "/w/f1.txt", { view: "/w/net.uview.json" });
    expect(t.ui.calls.showReview[0].view).toEqual({ error: "bad_path" });
    t.fakeFs.set("/w/bad.uview.json", "{not a spec");
    await openOne(t, s, "x", "/w/f2.txt", { view: "/w/bad.uview.json" });
    expect(t.ui.calls.showReview[1].view).toEqual({ error: "invalid_spec" });
    t.fakeFs.set("/w/huge.uview.json", Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    await openOne(t, s, "x", "/w/f3.txt", { view: "/w/huge.uview.json" });
    expect(t.ui.calls.showReview[2].view).toEqual({ error: "invalid_spec" });
    expect(t.fakeFs.state.live).toBe(0);
  });
});

describe("agent host: ownership, get and wait", () => {
  it("a session sees only its own reviews: get, wait are not_found for anyone else, and cancelWait does nothing to them", async () => {
    // Mutation: reviews visible across sessions (a leak of decisions between agents)
    const t = await makeHost();
    const a = newSession();
    const b = newSession();
    const { reviewId } = await openOne(t, a);
    expect(await t.call(a, "review.get", { reviewId })).toEqual({ status: "pending" });
    expect(await t.fail(b, "review.get", { reviewId })).toBe("not_found");
    expect(await t.fail(b, "review.wait", { reviewId, timeoutMs: 1000 })).toBe("not_found");
    let waited: any = null;
    const waiting = t.call(a, "review.wait", { reviewId, timeoutMs: 10_000 }).then((r: any) => (waited = r));
    await flush();
    expect(await t.call(b, "review.cancelWait", { reviewId })).toEqual({});
    await flush();
    expect(waited).toBeNull();
    await t.host.decideReview({ reviewId, decision: "dismissed" });
    await waiting;
    expect(waited.status).toBe("decided");
    expect(await t.fail(b, "review.get", { reviewId })).toBe("not_found");
  });

  it("unknown ids are not_found; a missing, non-string or over-long id is bad_request", async () => {
    // Mutation: an existence oracle, or crashing on junk ids
    const t = await makeHost();
    const s = newSession();
    expect(await t.fail(s, "review.get", { reviewId: "f".repeat(32) })).toBe("not_found");
    expect(await t.fail(s, "review.get", {})).toBe("bad_request");
    expect(await t.fail(s, "review.get", { reviewId: 5 })).toBe("bad_request");
    expect(await t.fail(s, "review.get", { reviewId: "" })).toBe("bad_request");
    expect(await t.fail(s, "review.get", { reviewId: "x".repeat(129) })).toBe("bad_request");
    expect(await t.fail(s, "review.get", { reviewId: "x".repeat(128) })).toBe("not_found");
    expect(await t.fail(s, "review.wait", { reviewId: "x".repeat(129), timeoutMs: 1 })).toBe("bad_request");
    expect(await t.fail(s, "review.cancelWait", { reviewId: 5 })).toBe("bad_request");
  });

  it("get returns the decision once the person decided", async () => {
    // Mutation: get stuck on pending, or returning a different decision object
    const t = await makeHost();
    const s = newSession();
    const { reviewId } = await openOne(t, s, "v1");
    await t.host.verifyReview(reviewId);
    const result = await t.host.decideReview({ reviewId, decision: "approved", comment: "ok" });
    expect(result.ok).toBe(true);
    const got = await t.call(s, "review.get", { reviewId });
    expect(got.status).toBe("decided");
    expect(got.decision).toMatchObject({ uniview: "decision/1", reviewId, decision: "approved", comment: "ok", persisted: true });
    expect(got.decision.files).toEqual([{ path: "/w/f.txt", expectedSha256: sha256("v1"), observedSha256: sha256("v1"), state: "unchanged" }]);
    expect(await t.store.hasDecision(reviewId)).toBe(true);
  });

  it("wait resolves with the decision when it arrives, and at once when the review is already decided", async () => {
    // Mutation: wait never resolving on a decision, or waiting on a decided review
    const t = await makeHost();
    const s = newSession();
    const { reviewId } = await openOne(t, s);
    let waited: any = null;
    const waiting = t.call(s, "review.wait", { reviewId, timeoutMs: 3_600_000 }).then((r: any) => (waited = r));
    await flush();
    expect(waited).toBeNull();
    await t.host.verifyReview(reviewId);
    await t.host.decideReview({ reviewId, decision: "changes_requested", comment: "no" });
    await waiting;
    expect(waited).toMatchObject({ status: "decided", decision: { decision: "changes_requested", comment: "no" } });
    expect(t.clock.pending()).toBe(0);
    expect(await t.call(s, "review.wait", { reviewId, timeoutMs: 3_600_000 })).toMatchObject({ status: "decided" });
  });

  it("wait times out as pending at exactly timeoutMs (limit), not one millisecond earlier, and the review stays open", async () => {
    // Mutation: wrong unit (seconds), timing out early or late, or closing the review on timeout
    const t = await makeHost();
    const s = newSession();
    const { reviewId } = await openOne(t, s);
    let waited: any = null;
    const waiting = t.call(s, "review.wait", { reviewId, timeoutMs: 5000 }).then((r: any) => (waited = r));
    await t.clock.advance(4999);
    expect(waited).toBeNull();
    await t.clock.advance(1);
    await waiting;
    expect(waited).toEqual({ status: "pending" });
    expect(await t.call(s, "review.get", { reviewId })).toEqual({ status: "pending" });
    expect(t.clock.pending()).toBe(0);
  });

  it("timeoutMs 0 (or omitted) answers at once; invalid timeouts are bad_request; 2^31-1 is accepted and 2^31 is not", async () => {
    // Mutation: waiting forever, or accepting values setTimeout cannot hold
    const t = await makeHost();
    const s = newSession();
    const { reviewId } = await openOne(t, s);
    expect(await t.call(s, "review.wait", { reviewId, timeoutMs: 0 })).toEqual({ status: "pending" });
    expect(await t.call(s, "review.wait", { reviewId })).toEqual({ status: "pending" });
    for (const bad of [-1, 1.5, "5", null, 2 ** 31]) expect(await t.fail(s, "review.wait", { reviewId, timeoutMs: bad })).toBe("bad_request");
    const long = t.call(s, "review.wait", { reviewId, timeoutMs: 2 ** 31 - 1 });
    await flush();
    t.host.onSessionClosed(s.sessionId);
    expect(await long).toEqual({ status: "pending" });
  });

  it("cancelWait ends this session's waits as pending; the review stays open and can still be decided", async () => {
    // Mutation: cancel closing/dismissing the review, or not ending the wait
    const t = await makeHost();
    const s = newSession();
    const { reviewId } = await openOne(t, s);
    const results: any[] = [];
    const w1 = t.call(s, "review.wait", { reviewId, timeoutMs: 100_000 }).then((r: any) => results.push(r));
    const w2 = t.call(s, "review.wait", { reviewId, timeoutMs: 100_000 }).then((r: any) => results.push(r));
    await flush();
    expect(await t.call(s, "review.cancelWait", { reviewId })).toEqual({});
    await Promise.all([w1, w2]);
    expect(results).toEqual([{ status: "pending" }, { status: "pending" }]);
    expect(t.clock.pending()).toBe(0);
    expect(await t.call(s, "review.get", { reviewId })).toEqual({ status: "pending" });
    await t.host.verifyReview(reviewId);
    expect((await t.host.decideReview({ reviewId, decision: "approved" })).ok).toBe(true);
  });

  it("closing the connection cancels that session's waits (no leaked timers) but the review stays open for the person", async () => {
    // Mutation: waits surviving their connection, or the review being closed with it
    const t = await makeHost();
    const a = newSession();
    const b = newSession();
    const { reviewId } = await openOne(t, a);
    await openOne(t, b, "y", "/w/g.txt");
    const waiting = t.call(a, "review.wait", { reviewId, timeoutMs: 3_600_000 });
    await flush();
    expect(t.clock.pending()).toBe(1);
    t.host.onSessionClosed(a.sessionId);
    await waiting;
    expect(t.clock.pending()).toBe(0);
    expect(t.host.getReview(reviewId)).toMatchObject({ decision: null });
    expect(t.ui.calls.showReview).toHaveLength(2);
    // The person can still decide it, and it is not visible to anyone else.
    await t.host.verifyReview(reviewId);
    expect((await t.host.decideReview({ reviewId, decision: "approved" })).ok).toBe(true);
    expect(await t.fail(b, "review.get", { reviewId })).toBe("not_found");
    expect(t.host.getReview(reviewId)).toBeNull();
  });

  it("a decided review of a closed session is forgotten; one of an open session keeps being readable", async () => {
    // Mutation: decided reviews kept forever
    const t = await makeHost();
    const s = newSession();
    const { reviewId } = await openOne(t, s);
    await t.host.decideReview({ reviewId, decision: "dismissed" });
    expect(t.host.getReview(reviewId)).not.toBeNull();
    t.host.onSessionClosed(s.sessionId);
    expect(t.host.getReview(reviewId)).toBeNull();
  });

  it("limit: a session keeps its last 100 decided reviews readable; the 101st evicts the oldest (not_found)", async () => {
    // Mutation: unbounded memory per session, or evicting the newest
    const t = await makeHost();
    const s = newSession();
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) {
      if (i > 0 && i % 25 === 0) await t.clock.advance(60_000);
      const { reviewId } = await openOne(t, s, "x", "/w/f.txt");
      await t.host.decideReview({ reviewId, decision: "dismissed" });
      await t.host.tabClosed(t.ui.calls.showReview.at(-1).scopeId);
      ids.push(reviewId);
    }
    expect(await t.fail(s, "review.get", { reviewId: ids[0] })).toBe("not_found");
    expect((await t.call(s, "review.get", { reviewId: ids[1] })).status).toBe("decided");
    expect((await t.call(s, "review.get", { reviewId: ids[100] })).status).toBe("decided");
  });
});

describe("agent host: pending review limits", () => {
  it("limit: 8 pending reviews per session; the 9th is busy until one is decided", async () => {
    // Mutation: cap 7/9, a global instead of per-session count, or not freeing the slot on a decision
    const t = await makeHost();
    const s = newSession();
    const other = newSession();
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push((await openOne(t, s, "x", `/w/f${i}.txt`)).reviewId);
    t.fakeFs.set("/w/g.txt", "x");
    const body = Buffer.from(receiptJson([{ path: "/w/g.txt", sha256: sha256("x") }]));
    expect(await t.fail(s, "review.open", { inline: true }, body)).toBe("busy");
    expect(t.ui.calls.showReview).toHaveLength(8);
    await expect(t.call(other, "review.open", { inline: true }, body)).resolves.toHaveProperty("reviewId");
    await t.host.decideReview({ reviewId: ids[0]!, decision: "dismissed" });
    await expect(t.call(s, "review.open", { inline: true }, body)).resolves.toHaveProperty("reviewId");
    expect(await t.fail(s, "review.open", { inline: true }, body)).toBe("busy");
  });

  it("limit: 32 pending reviews overall; the 33rd is busy even for a session with room", async () => {
    // Mutation: no overall cap, or counting decided reviews
    const t = await makeHost();
    t.fakeFs.set("/w/g.txt", "x");
    const body = Buffer.from(receiptJson([{ path: "/w/g.txt", sha256: sha256("x") }]));
    const sessions = Array.from({ length: 5 }, () => newSession());
    for (let k = 0; k < 4; k++) for (let i = 0; i < 8; i++) await t.call(sessions[k]!, "review.open", { inline: true }, body);
    expect(await t.fail(sessions[4]!, "review.open", { inline: true }, body)).toBe("busy");
    const [first] = t.ui.calls.showReview;
    await t.host.decideReview({ reviewId: first.reviewId, decision: "dismissed" });
    await expect(t.call(sessions[4]!, "review.open", { inline: true }, body)).resolves.toHaveProperty("reviewId");
    expect(await t.fail(sessions[4]!, "review.open", { inline: true }, body)).toBe("busy");
  });

  it("parallel review.open calls cannot overshoot the per-session cap", async () => {
    // Mutation: checking the cap before the awaits but counting only after (a race)
    const t = await makeHost();
    const s = newSession();
    t.fakeFs.set("/w/g.txt", "x");
    const body = Buffer.from(receiptJson([{ path: "/w/g.txt", sha256: sha256("x") }]));
    let release!: () => void;
    t.ui.gate = new Promise<void>((r) => (release = r));
    let early = 0;
    const running = Promise.all(
      Array.from({ length: 12 }, () =>
        t.fail(s, "review.open", { inline: true }, body).then((r) => {
          if (r === "busy" && t.ui.gate) early++;
          return r;
        }),
      ),
    );
    for (let i = 0; i < 500 && t.ui.waiting + early < 12; i++) await new Promise((r) => setTimeout(r, 2));
    release();
    const results = await running;
    expect(results.filter((r) => r === "busy")).toHaveLength(4);
    expect(t.ui.calls.showReview).toHaveLength(8);
  });

  it("parallel review.open calls from several sessions cannot overshoot the overall cap of 32", async () => {
    // Mutation: the overall cap checked without counting reviews still being opened
    const t = await makeHost();
    t.fakeFs.set("/w/g.txt", "x");
    const body = Buffer.from(receiptJson([{ path: "/w/g.txt", sha256: sha256("x") }]));
    const sessions = Array.from({ length: 5 }, () => newSession());
    let release!: () => void;
    t.ui.gate = new Promise<void>((r) => (release = r)); // a slow renderer keeps every review "being opened"
    let early = 0;
    const running = Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        t.fail(sessions[i % 5]!, "review.open", { inline: true }, body).then((r) => {
          if (r === "busy" && t.ui.gate) early++;
          return r;
        }),
      ),
    );
    // Wait until every request is either refused or held in the renderer, so none can have committed yet.
    for (let i = 0; i < 500 && t.ui.waiting + early < 40; i++) await new Promise((r) => setTimeout(r, 2));
    release();
    const results = await running;
    expect(results.filter((r) => r === "busy")).toHaveLength(8);
    expect(t.ui.calls.showReview).toHaveLength(32);
  });

  it("a pending review of a closed connection still counts until it is decided", async () => {
    // Mutation: forgetting the open tab of a vanished agent (the cap would then be bypassable by reconnecting)
    const t = await makeHost();
    t.fakeFs.set("/w/g.txt", "x");
    const body = Buffer.from(receiptJson([{ path: "/w/g.txt", sha256: sha256("x") }]));
    const sessions = Array.from({ length: 5 }, () => newSession());
    for (let k = 0; k < 4; k++) {
      for (let i = 0; i < 8; i++) await t.call(sessions[k]!, "review.open", { inline: true }, body);
      t.host.onSessionClosed(sessions[k]!.sessionId);
    }
    expect(await t.fail(sessions[4]!, "review.open", { inline: true }, body)).toBe("busy");
  });
});

describe("agent host: deciding, dismissing and closing", () => {
  it("closing the review tab without deciding records 'dismissed', answers waiters, frees the slot and the handles", async () => {
    // Mutation: a closed tab leaving the review pending forever, or no decision for the waiting agent
    const t = await makeHost();
    const s = newSession();
    const { reviewId } = await openOne(t, s);
    const scopeId = t.ui.calls.showReview[0].scopeId;
    const waiting = t.call(s, "review.wait", { reviewId, timeoutMs: 100_000 });
    await flush();
    await t.host.tabClosed(scopeId);
    const done = await waiting;
    expect(done).toMatchObject({ status: "decided", decision: { decision: "dismissed", reviewId } });
    expect(await t.store.hasDecision(reviewId)).toBe(true);
    expect(t.host.listSessions()[0]!.pendingReviews).toBe(0);
    expect(t.clock.pending()).toBe(0);
    await t.host.tabClosed(scopeId);
    expect((await t.call(s, "review.get", { reviewId })).decision.decision).toBe("dismissed");
  });

  it("if the dismissal cannot be recorded the review is still released (not pending forever) and its waiter is answered", async () => {
    // Mutation: a store failure leaving a phantom pending review that blocks the quota for good
    const t = await makeHost();
    const s = newSession();
    const { reviewId } = await openOne(t, s);
    const waiting = t.call(s, "review.wait", { reviewId, timeoutMs: 100_000 });
    await flush();
    t.store.hasDecision = async () => {
      throw new Error("cannot tell");
    };
    await t.host.tabClosed(t.ui.calls.showReview[0].scopeId);
    expect(await waiting).toEqual({ status: "pending" });
    expect(t.host.listSessions()[0]!.pendingReviews).toBe(0);
    expect(t.host.getReview(reviewId)).toBeNull();
    expect(await t.fail(s, "review.get", { reviewId })).toBe("not_found");
  });

  it("verifying again after the file was replaced by an identical copy reports replaced (the first identity is kept)", async () => {
    // Mutation: forgetting the identity first seen when the review opened
    const t = await makeHost();
    const s = newSession();
    const { reviewId } = await openOne(t, s, "same");
    expect((await t.host.verifyReview(reviewId)).results[0].state).toBe("unchanged");
    t.fakeFs.replace("/w/f.txt", "same");
    expect((await t.host.verifyReview(reviewId)).results[0].state).toBe("replaced");
    t.fakeFs.replace("/w/f.txt", "same");
    expect((await t.host.verifyReview(reviewId)).results[0].state).toBe("replaced");
  });

  it("closing the tab of an already decided review changes nothing", async () => {
    // Mutation: overwriting an approval with 'dismissed' when the tab is closed afterwards
    const t = await makeHost();
    const s = newSession();
    const { reviewId } = await openOne(t, s);
    await t.host.verifyReview(reviewId);
    await t.host.decideReview({ reviewId, decision: "approved" });
    await t.host.tabClosed(t.ui.calls.showReview[0].scopeId);
    expect((await t.call(s, "review.get", { reviewId })).decision.decision).toBe("approved");
  });

  it("approving without having looked (no verification shown) is blocked as changed; after verifying it works once", async () => {
    // Mutation: approving files nobody has seen verified, or allowing a second decision
    const t = await makeHost();
    const s = newSession();
    const { reviewId } = await openOne(t, s);
    const blocked = await t.host.decideReview({ reviewId, decision: "approved" });
    expect(blocked).toMatchObject({ ok: false, code: "changed" });
    expect(await t.store.hasDecision(reviewId)).toBe(false);
    await t.host.verifyReview(reviewId);
    expect((await t.host.decideReview({ reviewId, decision: "approved" })).ok).toBe(true);
    await expect(t.host.decideReview({ reviewId, decision: "changes_requested" })).rejects.toMatchObject({ code: "already_decided" });
    expect((await t.call(s, "review.get", { reviewId })).decision.decision).toBe("approved");
  });

  it("a file changed after it was shown blocks the decision and refreshes what is shown; the next click works on the new state", async () => {
    // Mutation: approving a file that changed between viewing and clicking
    const t = await makeHost();
    const s = newSession();
    const { reviewId } = await openOne(t, s, "v1");
    await t.host.verifyReview(reviewId);
    t.fakeFs.modify("/w/f.txt", "v2 changed");
    const blocked = await t.host.decideReview({ reviewId, decision: "approved" });
    expect(blocked.ok).toBe(false);
    expect(blocked.current.results[0].state).toBe("changed");
    expect(t.host.getReview(reviewId)!.shown.results[0].state).toBe("changed");
    expect(await t.call(s, "review.get", { reviewId })).toEqual({ status: "pending" });
    const second = await t.host.decideReview({ reviewId, decision: "changes_requested", comment: "edited" });
    expect(second.ok).toBe(true);
    expect(second.decision.files[0]).toMatchObject({ state: "changed", observedSha256: sha256("v2 changed") });
  });

  it("a file replaced by another file with the same bytes (rename-replace) is detected", async () => {
    // Mutation: ignoring file identity between the shown and the click-time check
    const t = await makeHost();
    const s = newSession();
    const { reviewId } = await openOne(t, s, "same");
    await t.host.verifyReview(reviewId);
    t.fakeFs.replace("/w/f.txt", "same");
    expect(await t.host.decideReview({ reviewId, decision: "approved" })).toMatchObject({ ok: false, code: "changed" });
  });

  it("dismissing needs no verification, and unknown review ids are not_found", async () => {
    // Mutation: requiring a look before the person can say no
    const t = await makeHost();
    const { reviewId } = await openOne(t, newSession());
    expect((await t.host.decideReview({ reviewId, decision: "dismissed" })).ok).toBe(true);
    await expect(t.host.decideReview({ reviewId: "f".repeat(32), decision: "approved" })).rejects.toMatchObject({ code: "not_found" });
    await expect(t.host.verifyReview("f".repeat(32))).rejects.toMatchObject({ code: "not_found" });
  });

  it("the decision is activity-logged, and tab/session closing is safe when called repeatedly", async () => {
    // Mutation: no audit entry for decisions
    const t = await makeHost();
    const s = await t.approvedMcp();
    const { reviewId } = await openOne(t, s);
    await t.host.decideReview({ reviewId, decision: "dismissed" });
    expect(t.host.listActivity().map((e: any) => `${e.type}:${e.detail ?? ""}`)).toContain("review_decided:dismissed");
    t.host.onSessionClosed(s.sessionId);
    t.host.onSessionClosed(s.sessionId);
    expect(specJson()).toBeTruthy();
  });
});
