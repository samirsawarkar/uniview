import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWebBridge } from "../../src/shells/web";
import { installNativeOpenHook } from "../../src/shells";

describe("Native open error channel", () => {
  beforeEach(() => {
    delete (window as unknown as { __univiewOpen?: unknown }).__univiewOpen;
    delete (window as unknown as { __univiewOpenError?: unknown }).__univiewOpenError;
    delete (window as unknown as { __univiewOpenUrl?: unknown }).__univiewOpenUrl;
    delete (window as unknown as { __univiewPending?: unknown }).__univiewPending;
    delete (window as unknown as { __univiewPendingErrors?: unknown }).__univiewPendingErrors;
    vi.restoreAllMocks();
  });

  it("delivers errors queued before listener attaches", () => {
    const bridge = createWebBridge("capacitor");
    const openError = (window as unknown as { __univiewOpenError: (msg: string) => void }).__univiewOpenError;
    expect(openError).toBeDefined();

    openError("Queued error 1");
    openError("Queued error 2");

    const received: string[] = [];
    bridge.onExternalOpenError?.((msg) => received.push(msg));

    expect(received).toEqual(["Queued error 1", "Queued error 2"]);
  });

  it("supports unsubscribe so future errors are not delivered to removed listener", () => {
    const bridge = createWebBridge("capacitor");
    const openError = (window as unknown as { __univiewOpenError: (msg: string) => void }).__univiewOpenError;

    const received: string[] = [];
    const unsubscribe = bridge.onExternalOpenError?.((msg) => received.push(msg));
    expect(unsubscribe).toBeDefined();

    openError("Error while subscribed");
    expect(received).toEqual(["Error while subscribed"]);

    unsubscribe!();

    openError("Error after unsubscribe");
    expect(received).toEqual(["Error while subscribed"]);
  });

  it("drains initial native queue (__univiewPendingErrors)", () => {
    const w = window as unknown as {
      __univiewPendingErrors?: string[];
    };
    w.__univiewPendingErrors = ["Native cold-start error 1", "Native cold-start error 2"];

    const bridge = createWebBridge("capacitor");
    installNativeOpenHook();

    expect(w.__univiewPendingErrors).toEqual([]);

    const received: string[] = [];
    bridge.onExternalOpenError?.((msg) => received.push(msg));

    expect(received).toEqual(["Native cold-start error 1", "Native cold-start error 2"]);
  });

  it("handles failed fetch by emitting friendly filename-based error instead of rejecting", async () => {
    const bridge = createWebBridge("capacitor");
    installNativeOpenHook();

    const received: string[] = [];
    bridge.onExternalOpenError?.((msg) => received.push(msg));

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      })
    );

    const openUrl = (window as unknown as {
      __univiewOpenUrl: (url: string, name: string, mime?: string) => Promise<void>;
    }).__univiewOpenUrl;

    const promise = openUrl("file:///data/user/0/com.uniview.app/cache/secret_path/doc.pdf", "doc.pdf");
    await expect(promise).resolves.toBeUndefined();

    expect(received.length).toBe(1);
    expect(received[0]).toContain("doc.pdf");
    expect(received[0]).not.toContain("secret_path");
    expect(received[0]).not.toContain("404");
  });

  it("handles network rejection during fetch by emitting friendly error and resolving", async () => {
    const bridge = createWebBridge("capacitor");
    installNativeOpenHook();

    const received: string[] = [];
    bridge.onExternalOpenError?.((msg) => received.push(msg));

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network failed / file missing in cache"))
    );

    const openUrl = (window as unknown as {
      __univiewOpenUrl: (url: string, name: string, mime?: string) => Promise<void>;
    }).__univiewOpenUrl;

    const promise = openUrl("capacitor://localhost/_capacitor_file_/cache/shared.docx", "shared.docx");
    await expect(promise).resolves.toBeUndefined();

    expect(received.length).toBe(1);
    expect(received[0]).toContain("shared.docx");
    expect(received[0]).not.toContain("localhost");
    expect(received[0]).not.toContain("Error:");
    expect(received[0]).not.toContain("stack");
  });
});
