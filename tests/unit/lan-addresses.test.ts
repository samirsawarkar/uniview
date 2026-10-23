import { describe, it, expect } from "vitest";
// @ts-expect-error plain ESM module without types
import { lanAddresses } from "../../electron/lib/share-host.mjs";

function iface(address: string, opts?: { family?: "IPv4" | "IPv6"; internal?: boolean }) {
  return {
    address,
    family: opts?.family ?? "IPv4",
    internal: opts?.internal ?? false,
    netmask: "255.255.255.0",
    mac: "00:00:00:00:00:00",
    cidr: null,
  };
}

describe("lanAddresses", () => {
  it("filters out virtual adapters on Windows-like input", () => {
    const ifaces = {
      Ethernet: [iface("192.168.1.40")],
      "vEthernet (WSL (Hyper-V firewall))": [iface("172.21.144.1")],
      "VirtualBox Host-Only Network": [iface("192.168.56.1")],
      "Loopback Pseudo-Interface 1": [iface("127.0.0.1", { internal: true })],
    };

    const addrs = lanAddresses(ifaces);
    expect(addrs).toEqual(["192.168.1.40"]);
  });

  it("orders 192.168.x first, then 10.x, then 172.16-31.x", () => {
    const ifaces = {
      ethA: [iface("172.20.0.5")],
      ethB: [iface("10.0.0.1")],
      ethC: [iface("192.168.1.100")],
      ethD: [iface("192.168.2.200")],
    };

    const addrs = lanAddresses(ifaces);
    expect(addrs).toEqual(["192.168.1.100", "192.168.2.200", "10.0.0.1", "172.20.0.5"]);
  });

  it("skips 169.254, 100.64, and public addresses", () => {
    const ifaces = {
      eth0: [
        iface("169.254.10.20"),
        iface("100.64.0.1"),
        iface("8.8.8.8"),
        iface("142.250.190.46"),
        iface("192.168.1.15"),
      ],
    };

    const addrs = lanAddresses(ifaces);
    expect(addrs).toEqual(["192.168.1.15"]);
  });

  it("skips IPv6 addresses", () => {
    const ifaces = {
      eth0: [
        iface("fe80::1", { family: "IPv6" }),
        iface("2001:db8::1", { family: "IPv6" }),
        iface("::1", { family: "IPv6", internal: true }),
        iface("10.1.2.3", { family: "IPv4" }),
      ],
    };

    const addrs = lanAddresses(ifaces);
    expect(addrs).toEqual(["10.1.2.3"]);
  });

  it("falls back to private addresses without name filter when only filtered names have addresses", () => {
    const ifaces = {
      "vEthernet (WSL)": [iface("172.21.144.1")],
      docker0: [iface("172.17.0.1")],
      tailscale0: [iface("10.0.5.1")],
    };

    const addrs = lanAddresses(ifaces);
    expect(addrs).toEqual(["10.0.5.1", "172.21.144.1", "172.17.0.1"]);
  });
});
