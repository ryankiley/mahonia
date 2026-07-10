// Public discovery — the framework-agnostic logic behind the publish flow and
// the public /l/[slug] read view. Pure + DB-agnostic so it unit-tests without
// Nuxt or a database (the repo in server/utils/discoveryRepo.ts wires these to
// Postgres). Exposes ONLY public addresses (slug + share code) and never the
// internal id or edit token.

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
// Category segments — the ONE colour in the app (CategoryBar's data viz). Sums
// each folder's line weight, heaviest first; ungrouped weight rolls into
// "Other". Empty / weightless lists return [] (no bar — weight is optional).
// ---------------------------------------------------------------------------
export interface SparkSegment {
  colorKey: string;
  name: string;
  mg: number;
}

export function categorySegments(data: ListData): SparkSegment[] {
  const byFolder = new Map<string, SparkSegment>();
  // one lookup table instead of a folders.find() per item — this recomputes on
  // every edit (CategoryBar), so keep it O(items + folders)
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

