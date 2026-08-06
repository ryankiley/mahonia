// Trail link — the optional pointer from a packing list to the route it was packed
// for. An AllTrails page, a WTA hike, a CalTopo map, a ranger-district page, a blog
// trip report: ANY http(s) URL. There is no host allowlist anywhere in here.
//
// Two jobs, both pure:
//
//   1. Decide whether a stored URL is safe to render. Vue does NOT sanitize attribute
//      bindings, so a `javascript:`/`data:` value bound to :href executes on click.
//      This is the guard app/pages/changes.vue used to carry alone; it lives here now
//      so the two render sites can't drift (the same reason SLUG_RE moved into
//      discovery.ts).
//
//   2. Derive a readable NAME from the URL. The obvious alternative — fetch the page
//      and read its <title>/og:title — does not work: alltrails.com answers a
//      server-side GET with 403 whatever user-agent you send, and its robots.txt
//      disallows crawlers wholesale. Its SLUGS, happily, are more descriptive than
//      most og:titles, and reading them costs no network at all.
//
// The governing rule for the derivation is BE CONSERVATIVE, because the fallback is
// never bad: a bare hostname is honest and useful, and the owner can always type their
// own label. Every heuristic below therefore prefers to decline rather than to invent
// a title — a wrong name is worse than no name.

import { tidyText } from "./tidyText";

/** A stored trail URL resolved into the three pieces a view renders. */
export interface TrailLink {
  /** normalized, guaranteed http(s) — safe to bind to :href */
  href: string;
  /** hostname without a leading www. — the last-resort `name` when a URL is opaque */
  host: string;
  /** the owner's label, else a name derived from the path, else `host` */
  name: string;
}

// A derived name longer than this is truncated on a word boundary; longer than the
// hard limit it's discarded for the hostname. A 240-character path segment is not a
// trail name, it's junk (or an encoded blob), and truncating junk just yields shorter
// junk. Real names sit well under 72 — the longest in testing was 48.
const MAX_NAME_LEN = 72;
const ABSURD_NAME_LEN = MAX_NAME_LEN * 2;

// Lowercased mid-name, matching AllTrails' own casing ("… East Peak via Verna Dunshee
// Trail"). English-only by nature; a German or Japanese slug simply doesn't match, which
// leaves it title-cased — honest, not wrong.
const SMALL_WORDS = new Set([
  "a", "and", "at", "for", "in", "of", "on", "the", "to", "up", "via",
]);

// Path furniture, not names. A segment made only of these is skipped so the walk keeps
// looking (…/trail/7002176/mount-si-trail must not resolve to "Trail").
const GENERIC_SEGMENTS = new Set([
  "detail", "details", "en", "hike", "hikes", "home", "index", "map", "maps",
  "page", "route", "routes", "summary", "tour", "tours", "trail", "trails",
  "us", "view", "www",
]);

const FILE_EXT = /\.(?:html?|php|aspx?|jsp|cfm)$/i;
// AllTrails appends --2, --3 … to disambiguate same-named trails. Inert elsewhere:
// a real name doesn't end in a double-hyphenated integer.
const DISAMBIGUATION_SUFFIX = /--\d+$/;
const ASCII_TOKEN = /^[a-z0-9]+$/i;

/**
 * Any string → an http(s) URL, or null. The ONLY place a scheme is vetted; everything
 * that renders a user-supplied link goes through here.
 */
export function safeUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The hostname a viewer should see: no leading www. */
export function displayHost(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

/**
 * The URL as a human reads it — scheme and `www.` dropped, trailing slash gone.
 *
 * The card that shows this has one line and, on a phone, not many characters; the
 * eleven the scheme and `www.` take are the eleven that carry no information, and
 * they're at the FRONT, so an ellipsis eats the part that identifies the trail.
 * Same trimming the browser's own address bar does, and for the same reason.
 */
export function displayUrl(url: URL): string {
  return (displayHost(url) + url.pathname + url.search).replace(/\/$/, "");
}

// The stored bounds. They live here, applied INSIDE the normalizers, because the DB
// columns are bare `text` — these are the only limit there is, and a caller that
// remembered to normalize but forgot to clamp would be an unbounded write.
const MAX_TRAIL_URL_LEN = 2000; // matches an item's productUrl
const MAX_TRAIL_LABEL_LEN = 120;

/**
 * A raw trail URL → its canonical stored form, or null if it isn't a safe http(s) URL.
 * Every write path stores THIS rather than the typed string, so what's persisted is
 * already clamped, already normalized and already known-renderable (client and server
 * agree, and a hostile client can't smuggle a `javascript:` value into a shared list).
 */
export function normalizeTrailUrl(raw: string | null | undefined): string | null {
  return safeUrl(raw?.slice(0, MAX_TRAIL_URL_LEN))?.href ?? null;
}

/** A raw trail label → its stored form, or undefined when it's blank. */
export function normalizeTrailLabel(raw: string | null | undefined): string | undefined {
  // tidyText rather than a bare trim: this is a typed name like any other ("Ryan's
  // loop"), and it renders beside the list title, which gets the same pass.
  const label = tidyText(raw?.slice(0, MAX_TRAIL_LABEL_LEN) ?? "");
  return label || undefined;
}

// Shape heuristics for "this token is an id, not a word".
function looksLikeId(token: string): boolean {
  if (/^\d+$/.test(token)) return true;
  // Everything below is tuned on the Latin alphabet, so gate it to ASCII. Ungated, a
  // "no vowels ⇒ probably a hash" test reads 富士山, Ελλάδα and Крым as ids, and every
  // non-Latin trail name in the world silently collapses to a bare hostname.
  if (!ASCII_TOKEN.test(token)) return false;
  if (token.length >= 8 && !/[aeiou]/i.test(token)) return true;
  const digits = token.replace(/\D/g, "").length;
  return token.length >= 6 && digits > 0 && digits / token.length > 0.3;
}

function titleCase(token: string, index: number): string {
  const lower = token.toLowerCase();
  // Not a no-op only for Latin text; toLowerCase/toUpperCase leave CJK untouched.
  if (index > 0 && SMALL_WORDS.has(lower)) return lower;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function clampName(name: string): string | null {
  if (name.length <= MAX_NAME_LEN) return name;
  if (name.length > ABSURD_NAME_LEN) return null; // junk — the hostname is better
  const cut = name.slice(0, MAX_NAME_LEN);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** One path segment → a display name, or null if it doesn't read like one. */
function nameFromSegment(rawSegment: string): string | null {
  let segment: string;
  try {
    segment = decodeURIComponent(rawSegment);
  } catch {
    // A malformed escape (%E0%A4%A) would otherwise survive as literal text and land
    // in the name. Skip the segment; the walk continues, and the hostname backstops.
    return null;
  }
  segment = segment.replace(FILE_EXT, "").replace(DISAMBIGUATION_SUFFIX, "");
  const tokens = segment.split(/[-_+\s]+/).filter(Boolean);
  const words = tokens.filter((t) => !looksLikeId(t));
  // One word is too thin to trust: /planyourvisit/mistrail.htm would become
  // "Mistrail", a misreading of "Mist Trail". Two is the floor that still admits
  // wta.org/go-hiking/hikes/rattlesnake-ledge.
  if (words.length < 2) return null;
  if (words.every((w) => GENERIC_SEGMENTS.has(w.toLowerCase()))) return null;
  return clampName(words.map(titleCase).join(" "));
}

/**
 * A URL's path → a trail name, or null. Reads `pathname` only, so AllTrails' `?u=i`
 * tracking params and a `#reviews` fragment cost nothing.
 */
function deriveName(url: URL): string | null {
  const segments = url.pathname.split("/").filter(Boolean);
  // Walk from the END. The last segment is usually the name, but plenty of sites append
  // an opaque id (summitpost.org/mount-si/150340), so falling back through the path is
  // what recovers "Mount Si" instead of giving up at "150340".
  for (let i = segments.length - 1; i >= 0; i--) {
    const name = nameFromSegment(segments[i]!);
    if (name) return name;
  }
  return null;
}

/**
 * A stored trail URL (+ the owner's optional label) → the pieces a view renders, or
 * null when the URL isn't safe to render at all.
 */
export function parseTrailLink(
  rawUrl: string | null | undefined,
  rawLabel?: string | null,
): TrailLink | null {
  const url = safeUrl(rawUrl);
  if (!url) return null;
  const host = displayHost(url);
  const label = (rawLabel ?? "").trim();
  return { href: url.href, host, name: label || deriveName(url) || host };
}
