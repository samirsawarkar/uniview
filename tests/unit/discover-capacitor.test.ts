import { describe, expect, it, vi } from "vitest";
import { CapacitorHttp } from "@capacitor/core";
import { capacitorTransport } from "../../src/shells/capacitor-transport";
import { validateLanUrl } from "../../src/shells/lan-address";
import { discoverHost } from "../../shared/remote-client.mjs";

vi.mock("@capacitor/core", () => ({
  CapacitorHttp: {
    request: vi.fn(),
  },
}));

describe("discoverHost with capacitorTransport", () => {
  it("discovers host over LAN hello probe", async () => {
    vi.mocked(CapacitorHttp.request).mockImplementation(async (options: any) => {
      if (options.url === "http://192.168.1.35:47823/v1/hello") {
        return { status: 200, data: { app: "uniview", v: 1, hostId: "H" }, headers: {}, url: options.url };
      }
      throw new Error("Connection failed: " + options.url);
    });

    const host = await discoverHost({
      transport: capacitorTransport,
      hostId: "H",
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
