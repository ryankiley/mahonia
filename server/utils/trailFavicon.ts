// Favicons for trail-link hosts.
//
// A list's trail link renders nicer with the site's mark next to it, and unlike the
// page TITLE — which alltrails.com answers with a 403 whatever user-agent you send —
// /favicon.ico is CDN-served and fetches fine. So this is the one piece of the
// "rich link" idea worth keeping.
//
// The icon is inlined as a data: URL rather than hot-linked, so the site's strict
// `img-src 'self' data: blob:` (nuxt.config.ts) never has to loosen to let a viewer's
// browser hit a third-party host. It also means the mark can't become a tracking
// beacon on a shared list a stranger opens.
//
// Cached ONE ROW PER HOST (see trailFavicons in server/db/schema.ts): every list
// pointing at alltrails.com shares one row, so a popular site costs one fetch a month
// no matter how many lists link to it.

import { eq, lt, sql } from "drizzle-orm";
import { trailFavicons } from "../db/schema";
import { ensureTrailFaviconSchema, type Db } from "./db";
import { displayHost, safeUrl } from "../../shared/trailLink";
// the streaming, cancel-at-the-cap body reader — it started life in this file and
// now lives beside its sibling readJsonBodyCapped, since /api/import needs it too
import { readResponseCapped } from "./http";
import { isResolvedHostSafe, validateExternalUrl } from "./ssrf";

const FETCH_TIMEOUT_MS = 5_000;
const FETCH_USER_AGENT = "Mahonia trail-link/1.0 (+https://mahonia.app)";
// 64 KB. Real favicons are 1–6 KB; komoot.com serves a 112 KB icon, which is a page
// asset masquerading as a favicon and not worth carrying in every SSR response.
const MAX_BYTES = 64 * 1024;
// Only <head> is ever read, and that's near the top; this bounds a content-heavy
// homepage without needing to stream the whole document.
const MAX_HTML_BYTES = 256 * 1024;
const MAX_REDIRECT_HOPS = 5;
// A host is re-checked at most monthly. Long, because favicons almost never change and
// every refresh is an outbound request on someone else's server.
export const FAVICON_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Ceiling on distinct cached hosts. Any host is accepted, so without a cap a script
// pasting unique domains grows the table without bound. Past it, new hosts simply
// render without a mark — the LINK is never blocked.
const MAX_HOSTS = 5_000;
// Per sweep, so one night can't turn into a fetch storm.
const REFRESH_BATCH = 25;
// …and how many of those run at once. Enough to keep the sweep inside a serverless
// function's lifetime, low enough that we're never 25 simultaneous requests to the wider
// internet from one IP.
const REFRESH_CONCURRENCY = 5;

/**
 * GET a vetted URL, following redirects by hand and re-vetting every hop. Returns the
 * final response, or null.
 *
 * The hops are walked with the REAL GET rather than probed ahead with HEAD, because
 * sites routinely answer the two differently and then the probe's answer is a lie:
 * www.notion.so returns 200 to HEAD but redirects GET onward to www.notion.com, so a
 * HEAD-resolved "final" URL handed to a GET came back 3xx and got thrown away as
 * not-ok. Walking the GET also halves the requests.
 *
 * `redirect: "follow"` is not an option — it would let a 302 from a vetted public host
 * land on an internal address unchecked, which is the whole point of the guards below.
 */
async function safeGet(target: URL): Promise<Response | null> {
  let current: URL | null = target;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    if (!current) return null;
    // every hop, not just the first: shape + literal-IP checks, then a DNS lookup that
    // catches a hostname resolving to a private address
    if (!validateExternalUrl(current.href)) return null;
    if (!(await isResolvedHostSafe(current.hostname))) return null;

    // annotated: `current` is reassigned from this block, so inference would go circular
    const res: Response = await fetch(current.href, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "manual",
      headers: { "user-agent": FETCH_USER_AGENT },
    });

    if (res.status >= 300 && res.status < 400) {
      const nextHref: string | null = res.headers.get("location");
      if (!nextHref) return null;
      try {
        current = new URL(nextHref, current);
      } catch {
        return null;
      }
      continue;
    }
    return res.ok ? res : null;
  }
  return null; // too many redirects
}

/** Fetch one image URL as a data: URL, or null if it isn't a usable image.
 *  Swallows its OWN errors so a thrown /favicon.ico doesn't abort the HTML fallback. */
async function imageAsDataUrl(target: URL): Promise<string | null> {
  const res = await safeGet(target).catch(() => null);
  if (!res) return null;
  // Plenty of sites answer a missing favicon with a 200 HTML page rather than a 404 —
  // fatmap.com serves text/html from /favicon.ico. Without this check that page would
  // be base64'd into an <img> and render as a broken image on every shared list.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) return null;
  const read = await readResponseCapped(res, MAX_BYTES, "reject");
  if (!read.ok || !read.body) return null;
  const buffer = read.body;
  // strip charset/parameters — `image/vnd.microsoft.icon;charset=UTF-8` is a real response
  return `data:${contentType.split(";")[0]!.trim()};base64,${buffer.toString("base64")}`;
}

// Well-known icon paths, HIGHEST RESOLUTION FIRST. /favicon.ico is the last resort, not
// the first guess: it's conventionally 16×16, which is visibly soft on a 2× display —
// alltrails.com serves an 848-byte 16×16 .ico and a 5 KB 192×192 apple-touch-icon.png
// from the same origin, so asking in the wrong order gets the worst icon available.
const ICON_PATHS = [
  "/apple-touch-icon.png", // conventionally 180–192px
  "/apple-touch-icon-precomposed.png",
  "/favicon-32x32.png",
  "/favicon.ico", // 16×16, but near-universal
];

// <link rel="...icon..." href="..."> in either attribute order. apple-touch-icon is
// tried first for the same resolution reason as the path list above.
const ICON_LINK_RES = [
  /<link\s[^>]*?rel=["'][^"']*apple-touch-icon[^"']*["'][^>]*?href=["']([^"']+)["']/i,
  /<link\s[^>]*?href=["']([^"']+)["'][^>]*?rel=["'][^"']*apple-touch-icon[^"']*["']/i,
  /<link\s[^>]*?rel=["'][^"']*icon[^"']*["'][^>]*?href=["']([^"']+)["']/i,
  /<link\s[^>]*?href=["']([^"']+)["'][^>]*?rel=["'][^"']*icon[^"']*["']/i,
];

/** Ask the homepage where its icon lives. Used only when the known paths came up empty. */
async function discoverIconUrl(host: string): Promise<URL | null> {
  const home = validateExternalUrl(`https://${host}/`);
  if (!home) return null;
  const res = await safeGet(home).catch(() => null);
  if (!res) return null;
  if (!(res.headers.get("content-type") ?? "").includes("html")) return null;
  const read = await readResponseCapped(res, MAX_HTML_BYTES, "truncate");
  if (!read.ok || !read.body) return null;
  // only <head> matters, and a content-heavy page can be megabytes
  const html = read.body.toString("utf8");
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd < 0 ? html : html.slice(0, headEnd);
  // Resolve relative hrefs against the page we ACTUALLY landed on, not the one we asked
  // for. Redirects across domains are routine — notion.so serves its homepage from
  // www.notion.com, and its icon href is the relative "/front-static/favicon.ico".
  // Resolving that against the requested host builds a URL on a domain that only runs an
  // API, and 404s; against the final host it's a 200.
  const base = res.url || home.href;
  for (const re of ICON_LINK_RES) {
    const href = head.match(re)?.[1];
    if (!href) continue;
    try {
      // may well point at another host again (gaiagps → www-static.gaiagps.com, fatmap →
      // cloudfront) — validateExternalUrl re-vets whatever comes out
      return validateExternalUrl(new URL(href, base).href);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * A host → its favicon as a data: URL, or null when there isn't a usable one. Never
 * throws: a favicon is decoration, and no failure here may affect whether a list saves.
 *
 * Well-known PATHS first, HTML discovery only as a fallback. That order is the opposite
 * of the portfolio's link-preview (which reads the HTML first) and it is deliberate: the
 * sites that matter most here block HTML scraping but serve their icons happily —
 * alltrails.com answers its homepage with 403 and /apple-touch-icon.png with 200. Going
 * HTML-first would lose the mark on the single most-linked site.
 *
 * The fallback still earns its place: gaiagps.com 404s every known path and declares its
 * icon in <link rel="icon">, and fatmap.com serves HTML from /favicon.ico.
 */
export async function fetchFaviconDataUrl(host: string): Promise<string | null> {
  try {
    for (const path of ICON_PATHS) {
      const target = validateExternalUrl(`https://${host}${path}`);
      if (!target) continue;
      const icon = await imageAsDataUrl(target);
      if (icon) return icon; // first hit wins — the list is ordered by resolution
    }
    const discovered = await discoverIconUrl(host);
    return discovered ? await imageAsDataUrl(discovered) : null;
  } catch {
    return null;
  }
}

/** The cached data: URL for a host, or null (unknown host, or a known-bad one). */
export async function getFavicon(db: Db, host: string): Promise<string | null> {
  const rows = await db
    .select({ dataUrl: trailFavicons.dataUrl })
    .from(trailFavicons)
    .where(eq(trailFavicons.host, host))
    .limit(1);
  return rows[0]?.dataUrl ?? null;
}

/** A trail URL → its host's favicon, fetching and caching it if the host is new.
 *  Returns what a caller should render, so nobody re-selects the row we just touched. */
export async function faviconForUrl(db: Db, trailUrl: string): Promise<string | null> {
  const url = safeUrl(trailUrl);
  if (!url) return null;
  return cacheFaviconForHost(db, displayHost(url));
}

/** Fire-and-forget warm for a URL that was just stored. Used by the write paths, which
 *  must never wait on (or fail because of) a third-party host. */
export function warmFavicon(db: Db, trailUrl: string | null | undefined): void {
  if (trailUrl) void faviconForUrl(db, trailUrl);
}

/**
 * Fetch + store a host's favicon if we've never seen it. Best-effort: called
 * fire-and-forget off the save path, and every failure is swallowed.
 *
 * A failed fetch still writes a row (with a null data_url). That NEGATIVE result is
 * load-bearing — it's what stops a host that 404s being re-fetched on every subsequent
 * save of every list that links to it.
 *
 * Returns the icon to render, so a caller that needs it doesn't re-select the row.
 */
export async function cacheFaviconForHost(db: Db, host: string): Promise<string | null> {
  try {
    await ensureTrailFaviconSchema(db);
    // select the VALUE, not just the key: on the common (cached) path this is the only
    // query the whole request needs
    const existing = await db
      .select({ dataUrl: trailFavicons.dataUrl })
      .from(trailFavicons)
      .where(eq(trailFavicons.host, host))
      .limit(1);
    if (existing.length) return existing[0]!.dataUrl ?? null; // known, positive OR negative

    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(trailFavicons);
    if (count >= MAX_HOSTS) return null; // ceiling reached — link renders, just unmarked

    const dataUrl = await fetchFaviconDataUrl(host);
    await db
      .insert(trailFavicons)
      .values({ host, dataUrl, fetchedAt: new Date() })
      // a concurrent save for the same host raced us here; theirs is just as good
      .onConflictDoNothing();
    return dataUrl;
  } catch {
    /* decoration — never let this surface on a save */
    return null;
  }
}

/**
 * Re-fetch the hosts whose icons are older than the TTL, oldest first. Returns what it
 * did so the cron route can log it.
 *
 * On a failed re-fetch the existing data_url is KEPT and only fetched_at moves: a
 * transient 500 must not blank a working mark, and a permanently dead host must not be
 * retried every single night.
 */
export async function refreshStaleFavicons(
  db: Db,
  now = new Date(),
): Promise<{ checked: number; updated: number }> {
  await ensureTrailFaviconSchema(db);
  const cutoff = new Date(now.getTime() - FAVICON_TTL_MS);
  const stale = await db
    .select({ host: trailFavicons.host, dataUrl: trailFavicons.dataUrl })
    .from(trailFavicons)
    .where(lt(trailFavicons.fetchedAt, cutoff))
    .orderBy(trailFavicons.fetchedAt)
    .limit(REFRESH_BATCH);

  // Fetched with bounded concurrency, not one at a time. A dead host burns the full
  // timeout on each of the four known paths plus discovery — ~30 s — so a sequential
  // batch of 25 could run past 12 minutes and be killed mid-sweep by the platform's
  // function limit, leaving the tail to time out again the next night.
  let updated = 0;
  const queue = [...stale];
  await Promise.all(
    Array.from({ length: REFRESH_CONCURRENCY }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const fresh = await fetchFaviconDataUrl(row.host);
        if (fresh && fresh !== row.dataUrl) updated++;
        await db
          .update(trailFavicons)
          .set({ dataUrl: fresh ?? row.dataUrl, fetchedAt: now })
          .where(eq(trailFavicons.host, row.host));
      }
    }),
  );
  return { checked: stale.length, updated };
}
