/**
 * Strict LAN address validation for capacitorTransport.
 * Restricts destinations to literal RFC1918 IPv4 (10/8, 172.16/12, 192.168/16), loopback 127/8,
 * IPv6 loopback ::1, ULA fc00::/7, and link-local fe80::/10.
 * Rejects public IPs, DNS names, alternate IPv4 encodings, userinfo, zone IDs, and controls/injection.
 */

const IPV4_STRICT_REGEX = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

const ALLOWED_PATHS = new Set(["/v1/pair", "/v1/session", "/v1/rpc", "/v1/hello"]);

export function isLanIpv4(host: string): boolean {
  const match = IPV4_STRICT_REGEX.exec(host);
  if (!match) return false;
  const o0 = Number(match[1]);
  const o1 = Number(match[2]);
  const o2 = Number(match[3]);
  const o3 = Number(match[4]);
  if (o0 > 255 || o1 > 255 || o2 > 255 || o3 > 255) return false;

  // 127.0.0.0/8 (loopback)
  if (o0 === 127) return true;
  // 10.0.0.0/8 (RFC1918)
  if (o0 === 10) return true;
  // 172.16.0.0/12 (RFC1918: 172.16.0.0 - 172.31.255.255)
  if (o0 === 172 && o1 >= 16 && o1 <= 31) return true;
  // 192.168.0.0/16 (RFC1918)
  if (o0 === 192 && o1 === 168) return true;

  // 169.254 is link-local IPv4; excluded as Windows sharing already advertises IPv4 excluding 169.254
  return false;
}

export function canonicalizeLanIpv6(host: string): string | null {
  // Reject zone IDs, userinfo, controls, whitespace, or query/path characters
  if (host.includes("%") || host.includes("@") || /[\s\x00-\x1f\x7f/?#]/.test(host)) {
    return null;
  }

  let clean = host;
  if (clean.startsWith("[") || clean.endsWith("]")) {
    if (!clean.startsWith("[") || !clean.endsWith("]")) return null;
    clean = clean.slice(1, -1);
  }
  if (clean.includes("[") || clean.includes("]") || !clean.includes(":")) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(`http://[${clean}]`);
  } catch {
    return null;
  }

  const hostname = parsed.hostname;
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return null;
  const canonical = hostname.slice(1, -1).toLowerCase();

  // IPv6 loopback ::1
  if (canonical === "::1") return canonical;

  const firstHextet = canonical.split(":")[0];
  if (!firstHextet || !/^[0-9a-f]{1,4}$/i.test(firstHextet)) return null;
  const firstWord = parseInt(firstHextet, 16);

  // ULA fc00::/7 (0xfc00 - 0xfdff)
  if ((firstWord & 0xfe00) === 0xfc00) return canonical;

  // Link-local fe80::/10 (0xfe80 - 0xfebf)
  if ((firstWord & 0xffc0) === 0xfe80) return canonical;

  return null;
}

export function canonicalizeLanHost(host: string): string | null {
  if (typeof host !== "string" || !host) return null;
  if (host.includes("%") || host.includes("@") || /[\s\x00-\x1f\x7f/?#]/.test(host)) {
    return null;
  }
  if (isLanIpv4(host)) {
    return host;
  }
  const ipv6 = canonicalizeLanIpv6(host);
  if (ipv6) {
    return `[${ipv6}]`;
  }
  return null;
}

export function isValidPort(port: number): boolean {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function isValidPath(path: string): boolean {
  return typeof path === "string" && ALLOWED_PATHS.has(path);
}

export function validateLanUrl(host: string, port: number, path: string): string {
  const canonicalHost = canonicalizeLanHost(host);
  if (!canonicalHost) {
    throw new Error("LAN-only transport: destination must be a literal private LAN address (RFC1918 / loopback / ULA / link-local IPv6)");
  }
  if (!isValidPort(port)) {
    throw new Error("LAN-only transport: port must be an integer between 1 and 65535");
  }
  if (!isValidPath(path)) {
    throw new Error("LAN-only transport: path must be one of /v1/pair, /v1/session, /v1/rpc, /v1/hello");
  }
  return `http://${canonicalHost}:${port}${path}`;
}
