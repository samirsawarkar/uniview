import { describe, it, expect, vi } from "vitest";
import { RemoteHost, pairWithOffer } from "../../shared/remote-client.mjs";
import * as Proto from "../../shared/remote-protocol.mjs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const P = Proto as any;

describe("remote client multi-address error reporting", () => {
  async function createTwoHostOffer() {
    const hostIdentity = await P.generateIdentity(false);
    return P.makeOffer({ hosts: ["192.168.1.10", "192.168.1.20"], port: 47823, hostPub: hostIdentity.publicRaw, secret: P.randomBytes(32), name: "Test PC" });
  }

  it("pairWithOffer prefers HTTP 400 error answer over subsequent connection error", async () => {
    const offerText = await createTwoHostOffer();
    const device = await P.generateIdentity(false);

    const transport = vi.fn(async (targetHost: string) => {
      if (targetHost === "192.168.1.10") {
        return {
          status: 400,
          body: new TextEncoder().encode(JSON.stringify({ error: "bad request" })),
        };
      }
      throw new Error(`failed to connect to /${targetHost}:47823 after 8000ms`);
    });

    let error: any;
    try {
      await pairWithOffer(offerText, { transport, device, deviceName: "Test Phone" });
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.message).toContain("(400)");
    expect(error.message).not.toContain("failed to connect");
  });

  it("RemoteHost #openSession prefers HTTP 500 error answer over subsequent connection error", async () => {
    const hostIdentity = await P.generateIdentity(false);
    const clientDevice = await P.generateIdentity(false);

    const transport = vi.fn(async (targetHost: string) => {
      if (targetHost === "192.168.1.10") {
        return {
          status: 500,
          body: new TextEncoder().encode(JSON.stringify({ error: "internal server error" })),
        };
      }
      throw new Error(`failed to connect to /${targetHost}:47823 after 8000ms`);
    });

    const client = new RemoteHost(
      {
        hostId: "test-host",
        hostName: "Test PC",
        hostPub: P.b64u(hostIdentity.publicRaw),
        hosts: ["192.168.1.10", "192.168.1.20"],
        port: 47823,
        deviceId: "device-1",
        preferred: "192.168.1.10",
      },
      { transport, device: clientDevice }
    );

    let error: any;
    try {
      await client.info();
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.message).toContain("(500)");
    expect(error.message).not.toContain("failed to connect");
    expect(error.message).not.toBe(
      "Test PC is not reachable. Check that it is on, sharing is turned on, and you are on the same network."
    );
  });
});
