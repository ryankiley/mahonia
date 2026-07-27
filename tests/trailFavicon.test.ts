import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import { trailFavicons } from "../server/db/schema";
import { TRAIL_FAVICONS_DDL } from "../server/utils/db";
import {
  FAVICON_TTL_MS,
  cacheFaviconForHost,
  fetchFaviconDataUrl,
  getFavicon,
  refreshStaleFavicons,
} from "../server/utils/trailFavicon";

// Fresh in-memory PGlite with just the favicon cache (mirrors snapshots.test).
async function freshDb() {
  const db = drizzle(new PGlite(), { schema });
  for (const stmt of TRAIL_FAVICONS_DDL) await db.execute(sql.raw(stmt));
  return db;
}
type Db = Awaited<ReturnType<typeof freshDb>>;

const ICON = "data:image/x-icon;base64,AAAA";
const OTHER_ICON = "data:image/png;base64,BBBB";

/** Seed a cached host with an explicit age. */
async function seed(db: Db, host: string, dataUrl: string | null, ageMs: number) {
  await db
    .insert(trailFavicons)
    .values({ host, dataUrl, fetchedAt: new Date(Date.now() - ageMs) });
}

// DNS is stubbed so the suite is hermetic. Without it, isResolvedHostSafe's real lookup()
// rejects every `.example` host as unresolvable and bails before fetching — correct
// behaviour, but it would mean these tests exercised nothing.
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));

// The network is stubbed everywhere below: these tests are about the CACHE rules
// (what gets refetched, what's kept on failure), not about anyone's favicon.
function stubFetch(impl: (url: string) => Partial<Response> | null) {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const res = impl(String(input));
    if (!res) throw new Error("network down");
    return res as Response;
  });
}

function imageResponse(bytes: Uint8Array, contentType = "image/x-icon") {
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

function htmlResponse(html: string) {
  return {
    ...imageResponse(new TextEncoder().encode(html), "text/html; charset=utf-8"),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchFaviconDataUrl", () => {
  it("returns a data: URL so a strict img-src never has to loosen", async () => {
    stubFetch(() => imageResponse(new Uint8Array([1, 2, 3])));
    const out = await fetchFaviconDataUrl("example.com");
    expect(out).toMatch(/^data:image\/x-icon;base64,/);
  });

  it("strips charset parameters from the content type", async () => {
    // caltopo.com really does answer `image/vnd.microsoft.icon;charset=UTF-8`, and
    // that parameter would make the data: URL malformed
    stubFetch(() => imageResponse(new Uint8Array([1]), "image/vnd.microsoft.icon;charset=UTF-8"));
    expect(await fetchFaviconDataUrl("example.com")).toMatch(
      /^data:image\/vnd\.microsoft\.icon;base64,/,
    );
  });

  it("rejects a non-image body", async () => {
    // fatmap.com really does answer /favicon.ico with 200 text/html; base64'ing that
    // would render as a broken image on every shared list
    stubFetch((url) =>
      url.endsWith("/favicon.ico")
        ? imageResponse(new Uint8Array([60, 33]), "text/html; charset=utf-8")
        : null,
    );
    expect(await fetchFaviconDataUrl("fatmap.com")).toBeNull();
  });

  it("falls back to <link rel=icon> when /favicon.ico is missing", async () => {
    // gaiagps.com 404s /favicon.ico but declares its icon in the homepage <head>,
    // pointing at a DIFFERENT host (www-static.gaiagps.com)
    stubFetch((url) => {
      if (url.endsWith("/favicon.ico")) return null;
      if (url === "https://gaiagps.com/")
        return htmlResponse(
          `<html><head><link rel="icon" href="https://static.gaiagps.example/i.png"></head>`,
        );
      if (url === "https://static.gaiagps.example/i.png")
        return imageResponse(new Uint8Array([7]), "image/png");
      return null;
    });
    expect(await fetchFaviconDataUrl("gaiagps.com")).toMatch(/^data:image\/png;base64,/);
  });

  it("resolves a RELATIVE icon href against the site", async () => {
    stubFetch((url) => {
      if (url.endsWith("/favicon.ico")) return null;
      if (url === "https://hikingproject.example/")
        return htmlResponse(`<head><link rel="icon" href="/img/favicon.png"></head>`);
      if (url === "https://hikingproject.example/img/favicon.png")
        return imageResponse(new Uint8Array([8]), "image/png");
      return null;
    });
    expect(await fetchFaviconDataUrl("hikingproject.example")).toMatch(/^data:image\/png/);
  });

  it("prefers a high-res icon over the 16x16 /favicon.ico", async () => {
    // alltrails.com serves an 848-byte 16×16 .ico AND a 5 KB 192×192 apple-touch-icon
    // from the same origin. Asking for the .ico first gets a visibly soft mark on any
    // 2× display, so the known paths are ordered by resolution.
    stubFetch((url) => {
      if (url.endsWith("/apple-touch-icon.png")) return imageResponse(new Uint8Array([1]), "image/png");
      if (url.endsWith("/favicon.ico")) return imageResponse(new Uint8Array([2]), "image/x-icon");
      return null;
    });
    expect(await fetchFaviconDataUrl("alltrails.com")).toMatch(/^data:image\/png/);
  });

  it("still finds the .ico when no high-res icon exists", async () => {
    stubFetch((url) =>
      url.endsWith("/favicon.ico") ? imageResponse(new Uint8Array([2]), "image/x-icon") : null,
    );
    expect(await fetchFaviconDataUrl("oldsite.example")).toMatch(/^data:image\/x-icon/);
  });

  it("tries the known paths BEFORE the homepage", async () => {
    // Load-bearing ordering: alltrails.com answers its homepage with 403 but serves its
    // icons fine. Reading HTML first (as a general-purpose unfurler would) would lose
    // the mark on the single most-linked site.
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      if (url.endsWith("/apple-touch-icon.png")) return imageResponse(new Uint8Array([1]));
      return null; // homepage is blocked, as AllTrails' really is
    });
    await fetchFaviconDataUrl("alltrails.com");
    expect(seen).toEqual(["https://alltrails.com/apple-touch-icon.png"]); // homepage untouched
  });

  it("rejects an oversized icon", async () => {
    // komoot.com serves a 112 KB favicon — a page asset masquerading as one, and not
    // worth carrying inline in every SSR response
    stubFetch(() => imageResponse(new Uint8Array(128 * 1024)));
    expect(await fetchFaviconDataUrl("komoot.com")).toBeNull();
  });

  it("returns null rather than throwing when the host is unreachable", async () => {
    stubFetch(() => null);
    await expect(fetchFaviconDataUrl("nope.example")).resolves.toBeNull();
  });

  it("refuses to fetch a private address", async () => {
    // the host comes straight from a user-pasted URL, so this is the SSRF boundary
    stubFetch(() => imageResponse(new Uint8Array([1])));
    expect(await fetchFaviconDataUrl("127.0.0.1")).toBeNull();
    expect(await fetchFaviconDataUrl("169.254.169.254")).toBeNull();
    expect(await fetchFaviconDataUrl("localhost")).toBeNull();
  });
});

describe("cacheFaviconForHost", () => {
  it("stores a fetched icon once, then serves it from cache", async () => {
    const db = await freshDb();
    let calls = 0;
    stubFetch(() => {
      calls++;
      return imageResponse(new Uint8Array([1, 2, 3]));
    });

    await cacheFaviconForHost(db, "alltrails.com");
    expect(await getFavicon(db, "alltrails.com")).toMatch(/^data:image\//);

    // a second list linking to the same host must not re-fetch — that's the whole
    // point of keying the cache by host instead of by list
    await cacheFaviconForHost(db, "alltrails.com");
    expect(calls).toBe(1);
  });

  it("records a NEGATIVE result so a dead host isn't refetched on every save", async () => {
    const db = await freshDb();
    let calls = 0;
    stubFetch(() => {
      calls++;
      return null;
    });

    await cacheFaviconForHost(db, "dead.example");
    const afterFirst = calls; // .ico then the <link rel=icon> fallback — both dead
    await cacheFaviconForHost(db, "dead.example");

    expect(calls).toBe(afterFirst); // the second save hits the cache, not the network
    const rows = await db.select().from(trailFavicons).where(eq(trailFavicons.host, "dead.example"));
    expect(rows).toHaveLength(1); // the row exists…
    expect(rows[0]!.dataUrl).toBeNull(); // …carrying "we looked, there's nothing"
    expect(await getFavicon(db, "dead.example")).toBeNull();
  });

  it("never throws — a favicon must not be able to fail a list save", async () => {
    const db = await freshDb();
    stubFetch(() => {
      throw new Error("boom");
    });
    // resolves (rather than rejecting) with "no icon" — the caller renders a globe
    await expect(cacheFaviconForHost(db, "boom.example")).resolves.toBeNull();
  });
});

describe("refreshStaleFavicons", () => {
  it("refreshes only hosts past the TTL", async () => {
    const db = await freshDb();
    await seed(db, "fresh.example", ICON, 2 * 24 * 60 * 60 * 1000); // 2 days old
    await seed(db, "stale.example", ICON, FAVICON_TTL_MS + 60_000);

    const fetched: string[] = [];
    stubFetch((url) => {
      fetched.push(new URL(url).hostname);
      return imageResponse(new Uint8Array([9]), "image/png");
    });

    const result = await refreshStaleFavicons(db);
    expect(fetched).toEqual(["stale.example"]);
    expect(result.checked).toBe(1);
    expect(await getFavicon(db, "fresh.example")).toBe(ICON); // untouched
  });

  it("keeps the existing icon when a refetch fails, but still moves fetched_at", async () => {
    // A transient 500 must not blank a working mark, AND a permanently dead host must
    // not be retried every single night. Both halves matter.
    const db = await freshDb();
    await seed(db, "flaky.example", ICON, FAVICON_TTL_MS + 60_000);
    stubFetch(() => null);

    const before = (
      await db.select().from(trailFavicons).where(eq(trailFavicons.host, "flaky.example"))
    )[0]!.fetchedAt;

    await refreshStaleFavicons(db);

    const after = (
      await db.select().from(trailFavicons).where(eq(trailFavicons.host, "flaky.example"))
    )[0]!;
    expect(after.dataUrl).toBe(ICON); // kept
    expect(after.fetchedAt.getTime()).toBeGreaterThan(before.getTime()); // but not retried tomorrow
  });

  it("replaces the icon when a site rebrands", async () => {
    const db = await freshDb();
    await seed(db, "rebrand.example", ICON, FAVICON_TTL_MS + 60_000);
    stubFetch(() => imageResponse(new Uint8Array([66, 66, 66]), "image/png"));

    const result = await refreshStaleFavicons(db);
    expect(result.updated).toBe(1);
    expect(await getFavicon(db, "rebrand.example")).not.toBe(ICON);
    expect(await getFavicon(db, "rebrand.example")).toMatch(/^data:image\/png;base64,/);
  });

  it("caps how many hosts one sweep will fetch", async () => {
    // the batch cap is what stops one night's sweep becoming a fetch storm
    const db = await freshDb();
    for (let i = 0; i < 40; i++) {
      await seed(db, `host${i}.example`, OTHER_ICON, FAVICON_TTL_MS + i * 1000);
    }
    stubFetch(() => imageResponse(new Uint8Array([1])));

    const result = await refreshStaleFavicons(db);
    expect(result.checked).toBe(25);
    expect(result.checked).toBeLessThan(40);
  });

  it("takes the stalest hosts first, so nothing starves", async () => {
    const db = await freshDb();
    await seed(db, "recent.example", ICON, FAVICON_TTL_MS + 1000);
    await seed(db, "ancient.example", ICON, FAVICON_TTL_MS + 400 * 24 * 60 * 60 * 1000);

    const order: string[] = [];
    stubFetch((url) => {
      order.push(new URL(url).hostname);
      return imageResponse(new Uint8Array([1]));
    });

    await refreshStaleFavicons(db);
    expect(order[0]).toBe("ancient.example");
  });
});
