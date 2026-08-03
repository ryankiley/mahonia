// The redirect hop is the SSRF attack that matters. trailFavicon.test.ts proves a
// DIRECTLY private host is refused; this proves the pivot is too — a vetted public
// host answering 302 toward somewhere private. safeGet walks redirects by hand
// (redirect: "manual") precisely so it can re-run BOTH guards on every hop:
// validateExternalUrl catches a literal private IP in the Location header, and
// isResolvedHostSafe catches a public-looking hostname whose DNS points inside.
// If either re-vet ever regressed to `redirect: "follow"` semantics, the fetch
// log assertions here are what would catch it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFaviconDataUrl } from "../server/utils/trailFavicon";

// Per-host DNS, so one suite can hold a public host, a private-resolving host,
// and a public CDN at once (the shared favicon suite's stub answers one address
// for everything, which can't express this scenario).
const dns = vi.hoisted(() => ({ records: new Map<string, string>() }));
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    const address = dns.records.get(host);
    if (!address) throw new Error(`ENOTFOUND ${host}`);
    return [{ address, family: 4 }];
  },
}));

const PUBLIC_A = "93.184.216.34";

/** Stub fetch AND keep the log of every URL actually requested — the assertions
 *  here are as much about what was never fetched as about what came back. */
function stubFetch(impl: (url: string) => Partial<Response> | null): string[] {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    fetched.push(url);
    const res = impl(url);
    if (!res) throw new Error("network down");
    return res as Response;
  });
  return fetched;
}

function redirectResponse(location: string) {
  return { ok: false, status: 302, headers: new Headers({ location }) };
}

function imageResponse(bytes: Uint8Array, contentType = "image/png") {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { value: undefined, done: true };
            sent = true;
            return { value: bytes, done: false };
          },
          async cancel() {},
        };
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  dns.records.clear();
});

describe("safeGet re-vets every redirect hop", () => {
  it("follows a redirect that lands on another PUBLIC host — the walk itself works", async () => {
    // the positive control: with this passing, the nulls below mean "blocked",
    // not "redirect handling is broken"
    dns.records.set("trail.example", PUBLIC_A);
    dns.records.set("cdn.example", "151.101.1.140");
    stubFetch((url) => {
      if (url.startsWith("https://trail.example/"))
        return redirectResponse("https://cdn.example/icon.png");
      if (url === "https://cdn.example/icon.png") return imageResponse(new Uint8Array([9]));
      return null;
    });

    expect(await fetchFaviconDataUrl("trail.example")).toMatch(/^data:image\/png;base64,/);
  });

  it("blocks a 302 from a vetted public host to the link-local metadata address", async () => {
    dns.records.set("evil.example", PUBLIC_A);
    const fetched = stubFetch(() =>
      // every path answers with the classic IMDS pivot
      redirectResponse("http://169.254.169.254/latest/meta-data/"),
    );

    expect(await fetchFaviconDataUrl("evil.example")).toBeNull();

    // the public host WAS fetched (hop 1 passed its vet)…
    expect(fetched.some((u) => u.startsWith("https://evil.example/"))).toBe(true);
    // …and the private target never was — the hop was refused before any request
    expect(fetched.some((u) => u.includes("169.254.169.254"))).toBe(false);
  });

  it("blocks a 302 to a hostname whose DNS resolves to a private address", async () => {
    dns.records.set("evil.example", PUBLIC_A);
    // public-looking name, rebound inside — only the per-hop DNS check can see this
    dns.records.set("internal.example", "10.0.0.1");
    const fetched = stubFetch((url) => {
      if (url.startsWith("https://evil.example/"))
        return redirectResponse("https://internal.example/icon.png");
      // if the walk ever got here, a perfectly valid icon would come back and the
      // expect(null) below would fail — the block has to be the vet, nothing else
      return imageResponse(new Uint8Array([7]));
    });

    expect(await fetchFaviconDataUrl("evil.example")).toBeNull();
    expect(fetched.some((u) => u.startsWith("https://evil.example/"))).toBe(true);
    expect(fetched.some((u) => u.includes("internal.example"))).toBe(false);
  });
});
