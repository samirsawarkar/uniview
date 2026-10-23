import { describe, it, expect, vi, beforeEach } from "vitest";
import { CapacitorHttp } from "@capacitor/core";
import { capacitorTransport } from "../../src/shells/capacitor-transport";

vi.mock("@capacitor/core", () => ({
  CapacitorHttp: {
    request: vi.fn(),
  },
}));

describe("capacitorTransport (LAN-only security)", () => {
  const sampleBody = new Uint8Array([1, 2, 3, 4]);
  const contentType = "application/json";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("private IPv4 and IPv6 allowed + successful bytes roundtrip", () => {
    it("allows RFC1918 192.168.x.x and roundtrips base64 bytes", async () => {
      vi.mocked(CapacitorHttp.request).mockResolvedValueOnce({
        status: 200,
        data: "aGVsbG8=", // "hello" in base64
      } as any);

      const res = await capacitorTransport("192.168.1.50", 8080, "/v1/rpc", sampleBody, contentType);

      expect(CapacitorHttp.request).toHaveBeenCalledTimes(1);
      expect(CapacitorHttp.request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "http://192.168.1.50:8080/v1/rpc",
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          data: "AQIDBA==",
          dataType: "file",
          responseType: "arraybuffer",
          disableRedirects: true,
        })
      );
      expect(res.status).toBe(200);
      expect(new TextDecoder().decode(res.body)).toBe("hello");
    });

    it("allows RFC1918 10.x.x.x, 172.16-31.x.x, and loopback 127.x.x.x", async () => {
      vi.mocked(CapacitorHttp.request).mockResolvedValue({
        status: 200,
        data: "b2s=", // "ok"
      } as any);

      await capacitorTransport("10.0.0.1", 9000, "/v1/pair", sampleBody, contentType);
      expect(CapacitorHttp.request).toHaveBeenLastCalledWith(
        expect.objectContaining({ url: "http://10.0.0.1:9000/v1/pair" })
      );

      await capacitorTransport("172.16.0.1", 8080, "/v1/session", sampleBody, contentType);
      expect(CapacitorHttp.request).toHaveBeenLastCalledWith(
        expect.objectContaining({ url: "http://172.16.0.1:8080/v1/session" })
      );

      await capacitorTransport("172.31.255.254", 8080, "/v1/session", sampleBody, contentType);
      expect(CapacitorHttp.request).toHaveBeenLastCalledWith(
        expect.objectContaining({ url: "http://172.31.255.254:8080/v1/session" })
      );

      await capacitorTransport("127.0.0.1", 3000, "/v1/rpc", sampleBody, contentType);
      expect(CapacitorHttp.request).toHaveBeenLastCalledWith(
        expect.objectContaining({ url: "http://127.0.0.1:3000/v1/rpc" })
      );
    });

    it("allows IPv6 loopback ::1, ULA fc00::/7, and link-local fe80::/10", async () => {
      vi.mocked(CapacitorHttp.request).mockResolvedValue({
        status: 200,
        data: "b2s=",
      } as any);

      await capacitorTransport("::1", 8080, "/v1/rpc", sampleBody, contentType);
      expect(CapacitorHttp.request).toHaveBeenLastCalledWith(
        expect.objectContaining({ url: "http://[::1]:8080/v1/rpc" })
      );

      await capacitorTransport("[::1]", 8080, "/v1/rpc", sampleBody, contentType);
      expect(CapacitorHttp.request).toHaveBeenLastCalledWith(
        expect.objectContaining({ url: "http://[::1]:8080/v1/rpc" })
      );

      await capacitorTransport("fd12:3456:789a::1", 8080, "/v1/session", sampleBody, contentType);
      expect(CapacitorHttp.request).toHaveBeenLastCalledWith(
        expect.objectContaining({ url: "http://[fd12:3456:789a::1]:8080/v1/session" })
      );

      await capacitorTransport("fc00::1", 8080, "/v1/pair", sampleBody, contentType);
      expect(CapacitorHttp.request).toHaveBeenLastCalledWith(
        expect.objectContaining({ url: "http://[fc00::1]:8080/v1/pair" })
      );

      await capacitorTransport("fe80::1", 8080, "/v1/pair", sampleBody, contentType);
      expect(CapacitorHttp.request).toHaveBeenLastCalledWith(
        expect.objectContaining({ url: "http://[fe80::1]:8080/v1/pair" })
      );
    });
  });

  describe("Android CapacitorHttp body encoding behavior", () => {
    it("delivers binary bytes to the server even when caller requests application/json", async () => {
      let receivedServerBytes: Uint8Array | null = null;

      vi.mocked(CapacitorHttp.request).mockImplementation(async (options: any) => {
        const headerContentType = options.headers?.["Content-Type"] ?? "";
        if (typeof headerContentType === "string" && headerContentType.includes("application/json")) {
          // Android setRequestBody writes data as a literal UTF-8 string when Content-Type contains application/json
          receivedServerBytes = new TextEncoder().encode(options.data as string);
        } else if (options.dataType === "file") {
          // For non-JSON with dataType: "file", Android base64-decodes the bytes
          const binaryStr = atob(options.data as string);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
          receivedServerBytes = bytes;
        } else {
          receivedServerBytes = new TextEncoder().encode(options.data as string);
        }
        return {
          status: 200,
          data: "b2s=",
        } as any;
      });

      // 1. JSON payload sent with contentType = "application/json"
      const jsonBytes = new TextEncoder().encode(JSON.stringify({ v: 1 }));
      await capacitorTransport("192.168.1.50", 8080, "/v1/pair", jsonBytes, "application/json");
      expect(receivedServerBytes).not.toBeNull();
      expect(new TextDecoder().decode(receivedServerBytes!)).toBe('{"v":1}');

      // 2. Binary payload [0, 255, 1, 128] sent as "application/octet-stream"
      const binaryPayload = new Uint8Array([0, 255, 1, 128]);
      await capacitorTransport("192.168.1.50", 8080, "/v1/rpc", binaryPayload, "application/octet-stream");
      expect(receivedServerBytes).not.toBeNull();
      expect(Array.from(receivedServerBytes!)).toEqual([0, 255, 1, 128]);
    });
  });

  describe("rejections (public IPs, domain names, userinfo, ambiguous IPv4, invalid port/path)", () => {
    const sensitivePayload = new TextEncoder().encode("SENSITIVE_SECRET_TOKEN_DO_NOT_LOG");

    it("refuses public IPs and makes no request", async () => {
      const publicIps = ["8.8.8.8", "1.1.1.1", "142.250.190.46", "2001:4860:4860::8888"];
      for (const host of publicIps) {
        await expect(
          capacitorTransport(host, 8080, "/v1/rpc", sensitivePayload, contentType)
        ).rejects.toThrow(/LAN-only|local network/i);
      }
      expect(CapacitorHttp.request).not.toHaveBeenCalled();
    });

    it("refuses domain names / DNS and makes no request", async () => {
      const domains = ["example.com", "localhost", "my-server.local", "router.internal"];
      for (const host of domains) {
        await expect(
          capacitorTransport(host, 8080, "/v1/rpc", sensitivePayload, contentType)
        ).rejects.toThrow(/LAN-only|local network/i);
      }
      expect(CapacitorHttp.request).not.toHaveBeenCalled();
    });

    it("refuses userinfo, zone IDs, and control/injection attempts", async () => {
      const malicious = [
        "user:pass@192.168.1.1",
        "admin@10.0.0.1",
        "fe80::1%eth0",
        "fe80::1%25eth0",
        "192.168.1.1\r\nHost: evil.com",
        "192.168.1.1/v1/pair",
        "192.168.1.1?evil=1",
      ];
      for (const host of malicious) {
        await expect(
          capacitorTransport(host, 8080, "/v1/rpc", sensitivePayload, contentType)
        ).rejects.toThrow(/LAN-only|local network/i);
      }
      expect(CapacitorHttp.request).not.toHaveBeenCalled();
    });

    it("refuses ambiguous IPv4 encodings and 169.254 link-local", async () => {
      const ambiguous = [
        "0177.0.0.1",
        "127.000.000.001",
        "0x7f.0.0.1",
        "2130706433",
        "127.1",
        "127.0.1",
        "169.254.1.1",
        "172.32.0.1",
        "192.169.1.1",
        "0.0.0.0",
        "255.255.255.255",
      ];
      for (const host of ambiguous) {
        await expect(
          capacitorTransport(host, 8080, "/v1/rpc", sensitivePayload, contentType)
        ).rejects.toThrow(/LAN-only|local network/i);
      }
      expect(CapacitorHttp.request).not.toHaveBeenCalled();
    });

    it("refuses invalid ports and makes no request", async () => {
      const invalidPorts = [0, -1, 65536, 80.5, NaN];
      for (const port of invalidPorts) {
        await expect(
          capacitorTransport("192.168.1.1", port, "/v1/rpc", sensitivePayload, contentType)
        ).rejects.toThrow(/port/i);
      }
      expect(CapacitorHttp.request).not.toHaveBeenCalled();
    });

    it("refuses paths outside /v1/pair, /v1/session, /v1/rpc", async () => {
      const invalidPaths = [
        "/",
        "/v1/unknown",
        "/v2/rpc",
        "/v1/pair/subpath",
        "/v1/pair?query=1",
        "/v1/pair/../rpc",
      ];
      for (const path of invalidPaths) {
        await expect(
          capacitorTransport("192.168.1.1", 8080, path, sensitivePayload, contentType)
        ).rejects.toThrow(/path/i);
      }
      expect(CapacitorHttp.request).not.toHaveBeenCalled();
    });

    it("does not log or leak private payload in errors", async () => {
      try {
        await capacitorTransport("8.8.8.8", 8080, "/v1/rpc", sensitivePayload, contentType);
        expect.unreachable("should have thrown");
      } catch (err: any) {
        expect(err.message).not.toContain("SENSITIVE_SECRET_TOKEN_DO_NOT_LOG");
        expect(err.message).toMatch(/LAN-only|local network/i);
      }
    });
  });

  describe("redirect prevention", () => {
    it("sets disableRedirects: true and rejects 302 responses", async () => {
      vi.mocked(CapacitorHttp.request).mockResolvedValueOnce({
        status: 302,
        headers: { Location: "http://evil.com" },
        data: "",
      } as any);

      await expect(
        capacitorTransport("192.168.1.1", 8080, "/v1/rpc", sampleBody, contentType)
      ).rejects.toThrow(/redirect/i);

      expect(CapacitorHttp.request).toHaveBeenCalledWith(
        expect.objectContaining({
          disableRedirects: true,
        })
      );
    });

    it("rejects other 3xx status codes (301, 307, 308)", async () => {
      for (const status of [301, 307, 308]) {
        vi.mocked(CapacitorHttp.request).mockResolvedValueOnce({
          status,
          data: "",
        } as any);

        await expect(
          capacitorTransport("192.168.1.1", 8080, "/v1/session", sampleBody, contentType)
        ).rejects.toThrow(/redirect/i);
      }
    });
  });
});
