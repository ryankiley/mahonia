// Public discovery feed — the framework-agnostic logic behind the front-page
// feed, the publish flow, and the public /l/[slug] read view. Pure + DB-agnostic
// so it unit-tests without Nuxt or a database (the repo in
// server/utils/discoveryRepo.ts wires these to Postgres). The feed exposes ONLY
// public addresses (slug + share code) and never the internal id or edit token.

import { lineMg } from "./weights";
import type { ListData } from "./types";

// ---------------------------------------------------------------------------
// Trip type + season — a CLOSED enum each. Public free metadata is constrained
// to these slugs so a hostile publisher can't inject arbitrary strings into the
// feed (sanitization by allow-list, not escaping). Labels are sentence case
// (no all-caps, per the style pass).
// ---------------------------------------------------------------------------
interface Facet {
  slug: string;
  label: string;
}

const TRIP_TYPES: Facet[] = [
  { slug: "car-camping", label: "Weekend car camping" },
  { slug: "backpacking", label: "3-day backpacking" },
  { slug: "carry-on", label: "Carry-on travel" },
  { slug: "thru-hike", label: "Thru-hike" },
];

const SEASONS: Facet[] = [
  { slug: "three-season", label: "Three-season" },
  { slug: "summer", label: "Summer" },
  { slug: "fall", label: "Fall" },
  { slug: "winter", label: "Winter" },
  { slug: "spring", label: "Spring" },
];

const TRIP_SLUGS = new Set(TRIP_TYPES.map((t) => t.slug));
const SEASON_SLUGS = new Set(SEASONS.map((s) => s.slug));

/** A raw trip-type value → a known slug, or undefined (rejects anything else). */
export function normalizeTripType(raw: unknown): string | undefined {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return TRIP_SLUGS.has(s) ? s : undefined;
}

export function normalizeSeason(raw: unknown): string | undefined {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return SEASON_SLUGS.has(s) ? s : undefined;
}

export function tripTypeLabel(slug: string | null | undefined): string | undefined {
  return TRIP_TYPES.find((t) => t.slug === slug)?.label;
}

export function seasonLabel(slug: string | null | undefined): string | undefined {
  return SEASONS.find((s) => s.slug === slug)?.label;
}

// ---------------------------------------------------------------------------
// Public addresses. Slugs look like `{slug}-{6 crockford}`, lowercased. The
// shape rule lives HERE, once — the repo and every endpoint that validates a
// slug before a KV key or DB round-trip import it (three copies used to drift).
// ---------------------------------------------------------------------------
export const SLUG_RE = /^[a-z0-9-]{1,80}$/;

/** A raw slug value → its normalized (trimmed, lowercased) form, or null. */
export function normalizeSlug(raw: unknown): string | null {
  const s = (typeof raw === "string" ? raw : "").trim().toLowerCase();
  return SLUG_RE.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// Feed views (the sort). `recent` (the default) and `popular` are the calm
// sorts; `light` is the OPTIONAL lightest-packs leaderboard (base weight
// ascending) — one view, not the front door (weight is optional). Trip-type is
// an orthogonal filter (the front-page tabs), not a view.
// ---------------------------------------------------------------------------
export type FeedView = "recent" | "popular" | "light";
const FEED_VIEWS = new Set<FeedView>(["recent", "popular", "light"]);

export function normalizeView(raw: unknown): FeedView {
  const s = typeof raw === "string" ? (raw.trim().toLowerCase() as FeedView) : "recent";
  return FEED_VIEWS.has(s) ? s : "recent";
}

const FEED_LIMIT_DEFAULT = 24;
export const FEED_LIMIT_MAX = 60;

export function normalizeLimit(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return FEED_LIMIT_DEFAULT;
  return Math.min(FEED_LIMIT_MAX, n);
}

// ---------------------------------------------------------------------------
// Anti-spam — a cheap URL-count heuristic on a list's public free text. A list
// that's mostly links is almost always spam; flagged lists publish as `hidden`
// (default-safe, pending review) rather than landing live in the feed.
// ---------------------------------------------------------------------------
const SPAM_URL_THRESHOLD = 3;

// One match per link: an optional scheme/www prefix + a host with a known TLD,
// so "https://a.com" counts once (not once for the scheme and once for the host).
const URL_RE =
  /(?:https?:\/\/|www\.)?[a-z0-9-]+\.(?:com|net|org|io|ru|cn|shop|store|xyz|top|biz|info|link|click)\b/gi;

/** Count link-like tokens in free text (used by isLikelySpam). */
export function countLinks(text: string | null | undefined): number {
  if (!text) return 0;
  return (String(text).match(URL_RE) || []).length;
}

/** True when the combined public free text trips the link-spam heuristic. */
export function isLikelySpam(parts: { title?: string | null; description?: string | null }): boolean {
  return countLinks(`${parts.title ?? ""} ${parts.description ?? ""}`) >= SPAM_URL_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Category sparkline — the ONE colour on a card (the data viz). Sums each
// folder's line weight, takes the top 3 by weight, and rolls the remainder into
// "other". Empty / weightless lists return [] (no bar — weight is optional).
// Mirrors CategoryBar's folder-grouped model so cards and the read view agree.
// ---------------------------------------------------------------------------
export interface SparkSegment {
  colorKey: string;
  name: string;
  mg: number;
}

export function categorySegments(data: ListData): SparkSegment[] {
  const byFolder = new Map<string, SparkSegment>();
  // one lookup table instead of a folders.find() per item — this recomputes on
  // every edit (CategoryBar) and per feed card, so keep it O(items + folders)
  const folderById = new Map((data.folders ?? []).map((f) => [f.id, f]));
  let ungrouped = 0;
  for (const item of data.items ?? []) {
    const mg = lineMg(item);
    if (mg <= 0) continue;
    if (!item.folderId) {
      ungrouped += mg;
      continue;
    }
    const folder = folderById.get(item.folderId);
    const key = folder?.id ?? item.folderId;
    const existing = byFolder.get(key);
    if (existing) existing.mg += mg;
    else
      byFolder.set(key, {
        colorKey: folder?.colorKey ?? "other",
        name: folder?.name ?? "Other",
        mg,
      });
  }
  const segs = [...byFolder.values()];
  if (ungrouped > 0) segs.push({ colorKey: "other", name: "Other", mg: ungrouped });
  return segs.sort((a, b) => b.mg - a.mg);
}

/** Top-3 category segments + a rolled-up "other" remainder (for the card spark). */
export function sparkTop3(data: ListData): SparkSegment[] {
  const segs = categorySegments(data);
  if (segs.length <= 3) return segs;
  const top = segs.slice(0, 3);
  const restMg = segs.slice(3).reduce((s, x) => s + x.mg, 0);
  if (restMg > 0) top.push({ colorKey: "other", name: "Other", mg: restMg });
  return top;
}

// ---------------------------------------------------------------------------
// Publish decision — the pure rule for what a publish/unpublish does to a row,
// extracted from the repo so it unit-tests without a database.
//
// `flagged` withholds a list from the PUBLIC feed pending review (the spam
// heuristic tripping here, or a user report in the repo). It is deliberately
// NOT `status`: a flagged list stays `status='active'`, so the OWNER keeps full
// edit + share access — only public discovery is withheld. `status='hidden'/
// 'removed'` is reserved for real admin takedowns (which DO cut owner access);
// nothing user-facing sets it, so one bad actor can never lock a list's owner
// out of their own list.
// ---------------------------------------------------------------------------
interface PublishDecision {
  isPublic: boolean;
  flagged: boolean; // spam heuristic tripped → withhold from the feed (owner unaffected)
  stampPublishedAt: boolean; // caller stamps now() iff true
}

export function decidePublish(
  current: { hasPublishedAt: boolean; title?: string | null; description?: string | null },
  input: { isPublic: boolean },
): PublishDecision {
  const isPublic = !!input.isPublic;
  // a link-heavy list is withheld from the feed pending review — never a takedown
  const flagged = isPublic && isLikelySpam({ title: current.title, description: current.description });
  // published_at is stamped once — the first time the list goes public.
  const stampPublishedAt = isPublic && !current.hasPublishedAt;
  return { isPublic, flagged, stampPublishedAt };
}

/** Publish state shared by the editor dialog and the publish endpoint/repo.
 *  Carries only public addresses — no id, no edit token. */
export interface PublishState {
  isPublic: boolean;
  status: string; // active | hidden | removed
  flagged: boolean; // withheld from the public feed pending review (owner access intact)
  tripType?: string;
  season?: string;
  slug: string;
  shareCode: string;
}

// ---------------------------------------------------------------------------
// DiscoveryCard — the feed's wire shape. Carries ONLY public addresses; the
// internal numeric id and the edit token are never part of this object.
// ---------------------------------------------------------------------------
export interface DiscoveryCard {
  slug: string;
  shareCode: string;
  title: string;
  itemCount: number;
  tripType?: string;
  tripTypeLabel?: string;
  season?: string;
  seasonLabel?: string;
  baseWeightMg: number;
  totalWeightMg: number;
  hasWeights: boolean;
  spark: SparkSegment[];
  publishedAt?: string;
}

/** The minimal, DB-agnostic row shape a card needs (no id, no token). */
interface FeedRowInput {
  publicSlug: string;
  shareCode: string;
  title: string;
  itemCount: number;
  tripType?: string | null;
  season?: string | null;
  baseWeightMg: number;
  totalWeightMg: number;
  publishedAt?: string | Date | null;
  data: ListData;
}

function toIso(v: string | Date | null | undefined): string | undefined {
  if (!v) return undefined;
  return v instanceof Date ? v.toISOString() : String(v);
}

/** Shape a DB row into a feed card. Pure — never reads or exposes the id. */
export function cardFromRow(row: FeedRowInput): DiscoveryCard {
  return {
    slug: row.publicSlug,
    shareCode: row.shareCode,
    title: row.title,
    itemCount: Number(row.itemCount) || 0,
    tripType: row.tripType ?? undefined,
    tripTypeLabel: tripTypeLabel(row.tripType),
    season: row.season ?? undefined,
    seasonLabel: seasonLabel(row.season),
    baseWeightMg: Number(row.baseWeightMg) || 0,
    totalWeightMg: Number(row.totalWeightMg) || 0,
    hasWeights: (Number(row.totalWeightMg) || 0) > 0,
    spark: sparkTop3(row.data ?? { folders: [], items: [] }),
    publishedAt: toIso(row.publishedAt),
  };
}
