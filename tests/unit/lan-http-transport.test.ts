import { describe, it, expect, vi, beforeEach } from "vitest";

const { fakePlugin, capacitorHttpSpy } = vi.hoisted(() => ({
  fakePlugin: { post: vi.fn() },
  capacitorHttpSpy: { request: vi.fn() },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "android",
  },
  registerPlugin: () => fakePlugin,
  CapacitorHttp: capacitorHttpSpy,
}));

import { capacitorTransport } from "../../src/shells/capacitor-transport";

describe("capacitorTransport on Android (LanHttp)", () => {
  const sampleBody = new Uint8Array([1, 2, 3, 4]);
  const contentType = "application/json";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls fakePlugin.post with URL, base64 body, content type, and default timeouts/deadline/cap", async () => {
    fakePlugin.post.mockResolvedValueOnce({
      status: 200,
      body: "aGVsbG8=",
    });

    const res = await capacitorTransport("192.168.1.50", 8080, "/v1/rpc", sampleBody, contentType);

    expect(fakePlugin.post).toHaveBeenCalledTimes(1);
    expect(fakePlugin.post).toHaveBeenCalledWith({
      url: "http://192.168.1.50:8080/v1/rpc",
      body: "AQIDBA==",
      contentType: "application/json",
      connectTimeoutMs: 4000,
      readTimeoutMs: 20000,
      deadlineMs: 30000,
      maxResponseBytes: 8 * 1024 * 1024 + 64 * 1024,
    });
    expect(capacitorHttpSpy.request).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toBe("hello");
  });

  it("uses custom timeoutMs for connect, read, and deadline", async () => {
    fakePlugin.post.mockResolvedValueOnce({
      status: 200,
      body: "",
    });

    await capacitorTransport("192.168.1.50", 8080, "/v1/rpc", sampleBody, "application/custom", { timeoutMs: 1500 });

    expect(fakePlugin.post).toHaveBeenCalledTimes(1);
    expect(fakePlugin.post).toHaveBeenCalledWith(
      expect.objectContaining({
        connectTimeoutMs: 1500,
        readTimeoutMs: 1500,
        deadlineMs: 2000,
        contentType: "application/custom",
      })
    );
    expect(capacitorHttpSpy.request).not.toHaveBeenCalled();
  });

  it("never calls CapacitorHttp.request on Android", async () => {
    fakePlugin.post.mockResolvedValueOnce({
      status: 200,
      body: "",
    });

    await capacitorTransport("10.0.0.1", 47823, "/v1/hello", new Uint8Array(), "text/plain");
    expect(capacitorHttpSpy.request).not.toHaveBeenCalled();
  });

  it("rejects 3xx redirect answers", async () => {
    fakePlugin.post.mockResolvedValueOnce({
      status: 302,
      body: "",
    });

    await expect(
      capacitorTransport("192.168.1.50", 8080, "/v1/rpc", sampleBody, contentType)
    ).rejects.toThrow(/redirect/i);
    expect(capacitorHttpSpy.request).not.toHaveBeenCalled();
  });

  it("round-trips binary bodies via base64", async () => {
    const sentBytes = new Uint8Array([0, 255, 128, 42, 17]);
    const receivedBytes = new Uint8Array([10, 20, 30, 40]);
    const receivedB64 = btoa(String.fromCharCode(...receivedBytes));

    fakePlugin.post.mockResolvedValueOnce({
      status: 200,
      body: receivedB64,
    });

    const res = await capacitorTransport("192.168.1.50", 8080, "/v1/rpc", sentBytes, "application/octet-stream");

    const expectedSentB64 = btoa(String.fromCharCode(...sentBytes));
    expect(fakePlugin.post).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expectedSentB64,
      })
    );
    expect(res.body).toEqual(receivedBytes);
  });

  it("validates LAN URL before calling plugin and throws for public IP like 8.8.8.8", async () => {
    await expect(
      capacitorTransport("8.8.8.8", 8080, "/v1/rpc", sampleBody, contentType)
    ).rejects.toThrow("LAN-only transport: destination must be a literal private LAN address");

    expect(fakePlugin.post).not.toHaveBeenCalled();
    expect(capacitorHttpSpy.request).not.toHaveBeenCalled();
  });
});
