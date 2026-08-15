/**
 * SSRF guards for outbound fetches.
 *
 * The trail-link favicon fetch (server/utils/trailFavicon.ts) accepts ANY host a
 * user pastes — there is deliberately no allowlist — so the host is fully
 * attacker-controlled. Without these checks a request to
 * `http://my-redirect.com/` could pivot to `http://169.254.169.254/...` and
 * exfiltrate Vercel-provided env values, or hit an internal admin endpoint
 * on a private network. These helpers cover three angles:
 *
 *   1. validateExternalUrl — synchronous URL-shape + literal-IP checks. Rejects
 *      private CIDRs in dotted-decimal form, the alternate IPv4 encodings
 *      (`isIP` from `node:net` returns 0 for those, so we treat them as
 *      "not an IP" and fall through to DNS resolution).
 *   2. isResolvedHostSafe — async DNS lookup. Catches DNS records that
 *      resolve hostnames to private addresses.
 *
 * Callers walk redirects themselves, re-running (1) and (2) at every hop —
 * see safeGet in server/utils/trailFavicon.ts. That is not optional: both
 * `$fetch` and native fetch default to `redirect: "follow"`, which would let
 * a 302 from a vetted public host land on an internal IP unchecked.
 *
 * Threat model: Mahonia deployed on Vercel; no IMDS, no internal admin
 * services. Protection is defense-in-depth rather than gating a known
 * sensitive surface. A residual DNS-rebind window exists between
 * `isResolvedHostSafe` and the subsequent `fetch` connect — accepted for
 * this surface.
 *
 * Ported from the portfolio's link-preview implementation, which faces the same
 * "arbitrary user-supplied URL" problem. Keep the two in sync when either changes.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// IPv4 in dotted-decimal — `isIP` is canonical here and rejects octal
// (`0177.0.0.1`), hex (`0x7f.0.0.1`), and decimal (`2130706433`) variants by
// returning 0, so a non-zero result also means the address is well-formed.
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed = treat as untrusted
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 — "this host on this network"
    a === 10 || // 10.0.0.0/8 — RFC1918
    a === 127 || // 127.0.0.0/8 — loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 — link-local (IMDS lives here)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 — RFC1918
    (a === 192 && b === 168) || // 192.168.0.0/16 — RFC1918
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 — CGN (RFC 6598)
    a >= 224 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
  );
}

function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (s === "::" || s === "::1") return true; // unspecified, loopback
  if (/^fe[89ab][0-9a-f]:/i.test(s)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(s)) return true; // fc00::/7 unique-local
  if (/^ff/i.test(s)) return true; // ff00::/8 multicast
  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compat (::127.0.0.1) — match
  // both dotted-decimal authoring form and the canonical compressed-hex form
  // that WHATWG URL parsing emits (`::ffff:7f00:1`). Decode either and feed
  // through the v4 check.
  const v4Dotted = s.match(/(?:^::ffff:|^::)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (v4Dotted) return isPrivateIPv4(v4Dotted[1]!);
  const v4Hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4Hex) return isPrivateIPv4(hexPairToDotted(v4Hex[1]!, v4Hex[2]!));
  // 6to4 (RFC 3056): `2002:XXXX:YYYY::/48` — the 32 bits after the 2002:
  // prefix are the embedded IPv4. `2002:7f00:0001::` is the wrapper for
  // 127.0.0.1; without this, a 6to4 address whose embedded v4 is private
  // would slip past the literal-IP fast path (it would still be caught
  // downstream by `dns.lookup` returning the embedded v4, but checking
  // here closes the gap for direct-literal callers).
  const sixToFour = s.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?:[:]|$)/);
  if (sixToFour) return isPrivateIPv4(hexPairToDotted(sixToFour[1]!, sixToFour[2]!));
  // Teredo (RFC 4380): `2001::/32` — client v4 lives in the last 32 bits,
  // XOR'd with 0xffffffff. The compressed form makes the last two groups
  // sit at the tail of the string.
  const teredo = s.match(/^2001:0?:[0-9a-f:]+:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (teredo) {
    const high = parseInt(teredo[1]!, 16) ^ 0xffff;
    const low = parseInt(teredo[2]!, 16) ^ 0xffff;
    return isPrivateIPv4(`${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`);
  }
  return false;
}

function hexPairToDotted(highHex: string, lowHex: string): string {
  const high = parseInt(highHex, 16);
  const low = parseInt(lowHex, 16);
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function isPrivateAddress(host: string): boolean {
  const family = isIP(host);
  if (family === 4) return isPrivateIPv4(host);
  if (family === 6) return isPrivateIPv6(host);
  return false;
}

export function validateExternalUrl(input: string): URL | null {
  if (!input) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Reject credentials embedded in the URL — they're forwarded on redirects
  // and can be used to confuse origin checks.
  if (url.username || url.password) return null;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return null;
  if (host === "localhost" || host.endsWith(".localhost")) return null;
  if (isPrivateAddress(host)) return null;
  return url;
}

export async function isResolvedHostSafe(host: string): Promise<boolean> {
  if (isIP(host)) return true; // literal IP — already vetted by validateExternalUrl
  try {
    const records = await lookup(host, { all: true });
    if (!records.length) return false;
    return !records.some((r) => isPrivateAddress(r.address));
  } catch {
    return false;
  }
}

