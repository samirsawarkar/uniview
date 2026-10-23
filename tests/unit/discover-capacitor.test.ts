import { describe, expect, it, vi } from "vitest";
import { CapacitorHttp } from "@capacitor/core";
import { capacitorTransport } from "../../src/shells/capacitor-transport";
import { validateLanUrl } from "../../src/shells/lan-address";
import { discoverHost } from "../../shared/remote-client.mjs";
import * as Proto from "../../shared/remote-protocol.mjs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const P = Proto as any;

vi.mock("@capacitor/core", () => ({
  CapacitorHttp: {
    request: vi.fn(),
  },
}));

describe("discoverHost with capacitorTransport", () => {
  it("discovers host over LAN hello probe", async () => {
    const identity = await P.generateIdentity(false);
    const hostId: string = await P.idOf(identity.publicRaw);
    vi.mocked(CapacitorHttp.request).mockImplementation(async (options: any) => {
      if (options.url === "http://192.168.1.35:47823/v1/hello") {
        // CapacitorHttp gets the body as base64 and returns parsed JSON objects.
        const body = JSON.parse(atob(options.data));
        return { status: 200, data: await P.helloResponse(identity, hostId, body), headers: {}, url: options.url };
      }
      throw new Error("Connection failed: " + options.url);
    });

    const host = await discoverHost({
      transport: capacitorTransport,
      hostId,
      hostPub: identity.publicRaw,
      knownHosts: ["192.168.1.40"],
      port: 47823,
      timeoutMs: 300,
      concurrency: 64,
    });

    expect(host).toBe("192.168.1.35");
  });

  it("validateLanUrl rejects unauthorized paths", () => {
    expect(() => validateLanUrl("192.168.1.35", 47823, "/v1/admin")).toThrow(
      "LAN-only transport: path must be one of /v1/pair, /v1/session, /v1/rpc, /v1/hello",
    );
  });
});
