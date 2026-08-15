// Discovery + publish repository — all DB access for the PUBLIC surfaces
// (the /l/[slug] read view, the sitemap, the publish toggle, list reports).
//
// Capability-based, exactly like listRepo.ts: a writer holds an edit token, the
// public reads address a list by its slug. The internal numeric `id` and the
// `edit_token_hash` NEVER leave this module — the public view exposes only
// `public_slug` + `share_code`, so the edit capability can't be derived from
// anything public. Misses return null → the endpoints answer 404 (never 403),
// so there's no existence/enumeration oracle.
//
// Each function takes an OPTIONAL db (defaults to useDb()) so the query logic
// is exercisable against an in-memory PGlite in tests — endpoints call the
// no-arg form. The decision logic itself lives in shared/discovery.ts.
//
// Lives in its own file (not listRepo.ts) so this Phase-3 work stays additive
// and merge-clean alongside the concurrent rate-limiter + component sessions.

import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { lists, type ListRow } from "../db/schema";
import {
  decidePublish,
  normalizeSeason,
  normalizeSlug,
  normalizeTripType,
  type PublishState,
} from "../../shared/discovery";
import type { ListSnapshot } from "../../shared/types";
import { useDb } from "./db";
import {
  attachAuthorName,
  findPublishFieldsByEditHash,
  hydrateForRead,
  rowToSnapshot,
} from "./listRepo";
import { sha256Hex } from "./tokens";

type Db = Awaited<ReturnType<typeof useDb>>;

// The public-read visibility gate (public + active + not withheld + not deleted),
// single-sourced so the by-slug reads (getPublicBySlug / bumpView / reportList) and
// the sitemap can't drift. Returns a FRESH array each call so callers can safely
// spread + extend it without leaking conditions across requests. (Slug shape
// validation is shared/discovery's normalizeSlug; the live edit-capability lookup
// is listRepo's findPublishFieldsByEditHash, which shares findByEditHash's exact
// gate on a narrower projection — both imported above.)
function publicReadConditions() {
  return [
    eq(lists.isPublic, true),
    eq(lists.status, "active"),
    eq(lists.flagged, false),
    isNull(lists.deletedAt),
  ];
}

// ---------------------------------------------------------------------------
// Publish flow (write — edit token). Sets is_public + the feed facets. Only the
// public address is ever returned (PublishState lives in shared/discovery.ts so
// the editor dialog shares the exact shape).
// ---------------------------------------------------------------------------
function publicState(row: {
  isPublic: boolean;
  status: string;
  flagged: boolean;
  tripType: string | null;
  season: string | null;
  publicSlug: string;
  shareCode: string;
}): PublishState {
  return {
    isPublic: row.isPublic,
    status: row.status,
    flagged: row.flagged,
    tripType: row.tripType ?? undefined,
    season: row.season ?? undefined,
    slug: row.publicSlug,
    shareCode: row.shareCode,
  };
}

/** Current publish state for the editor's modal to prefill. Null → 404.
 *  Hash-first like listRepo's pairs: the endpoint gate (editAuth) resolves either
 *  capability — bearer token or session + claimed code — to the same hash. */
export async function getPublishStateByEditHash(
  editHash: string,
  db?: Db,
): Promise<PublishState | null> {
  const d = db ?? (await useDb());
  // narrow read: publish state is a handful of small columns, and this is the
  // editor's prefill — no reason to drag the list's whole JSONB across for it
  const row = await findPublishFieldsByEditHash(editHash, d);
  return row ? publicState(row) : null;
}

export async function getPublishState(editToken: string, db?: Db): Promise<PublishState | null> {
  return getPublishStateByEditHash(sha256Hex(editToken), db);
}

/**
 * Set a list public/private + its feed facets. The decision (spam→hidden,
 * stamp-once published_at, no resurrecting a moderated list) is decidePublish()
 * in shared/. Only the public address is returned.
 */
export async function publishListByEditHash(
  editHash: string,
  input: { isPublic: boolean; tripType?: string | null; season?: string | null },
  db?: Db,
): Promise<PublishState | null> {
  const d = db ?? (await useDb());
  // same narrow read as the prefill — publishing decides on title/description/
  // publishedAt/flagged and writes facets; it never touches `data`.
  const row = await findPublishFieldsByEditHash(editHash, d);
  if (!row) return null;

  const tripType = normalizeTripType(input.tripType) ?? null;
  const season = normalizeSeason(input.season) ?? null;
  const decision = decidePublish(
    { hasPublishedAt: !!row.publishedAt, title: row.title, description: row.description },
    { isPublic: !!input.isPublic },
  );
  const publishedAt = decision.stampPublishedAt ? new Date() : row.publishedAt;
  // flagging is sticky: a republish can never self-clear a flag (only admin review can).
  // `status` is left untouched — publishing never affects the owner's edit/share access.
  const flagged = row.flagged || decision.flagged;

  await d
    .update(lists)
    .set({
      isPublic: decision.isPublic,
      flagged,
      tripType,
      season,
      publishedAt,
      updatedAt: new Date(),
    })
    .where(eq(lists.id, row.id));

  return publicState({ ...row, isPublic: decision.isPublic, flagged, tripType, season });
}

export async function publishList(
  editToken: string,
  input: { isPublic: boolean; tripType?: string | null; season?: string | null },
  db?: Db,
): Promise<PublishState | null> {
  return publishListByEditHash(sha256Hex(editToken), input, db);
}

// ---------------------------------------------------------------------------
// Public read view (/l/[slug]) — resolves ONLY if the list is public. Returns a
// ListSnapshot-shaped view (reuses the readonly components + TotalsBar) minus
// the id + token. Null → 404.
// ---------------------------------------------------------------------------
function rowToPublicView(row: ListRow): ListSnapshot {
  // Same base shape as the edit/share snapshot, plus the public-feed facets.
  return {
    ...rowToSnapshot(row),
    tripType: row.tripType ?? undefined,
    season: row.season ?? undefined,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : undefined,
  };
}

/** The one public-row lookup behind /l and its social card — same normalization,
 *  same publicReadConditions predicate, so the card dies with the listing
 *  exactly like the page. */
async function publicRowBySlug(slug: string, db?: Db): Promise<{ d: Db; row: ListRow } | null> {
  const s = normalizeSlug(slug);
  if (!s) return null;
  const d = db ?? (await useDb());
  const rows = await d
    .select()
    .from(lists)
    .where(and(eq(lists.publicSlug, s), ...publicReadConditions()))
    .limit(1);
  return rows[0] ? { d, row: rows[0] } : null;
}

export async function getPublicBySlug(slug: string, db?: Db): Promise<ListSnapshot | null> {
  const hit = await publicRowBySlug(slug, db);
  if (!hit) return null;
  // hydrate like every listRepo snapshot read — the indexable /l page must show
  // the same current catalog names (and trail-link favicon) as /s and the editor,
  // not the add-time ones — plus the byline, which names this list's author, not
  // whoever happens to be viewing it
  const snap = await hydrateForRead(hit.d, rowToPublicView(hit.row));
  return attachAuthorName(hit.d, snap, hit.row.authorUserId);
}

/**
 * The same public-only lookup for the social-card image (/og/l), WITHOUT the
 * read-view hydration — the card never draws catalog names, the favicon or the
 * byline, and none of them can move a total (see getCardByShareCode, its /og/s
 * twin).
 */
export async function getPublicCardBySlug(slug: string, db?: Db): Promise<ListSnapshot | null> {
  const hit = await publicRowBySlug(slug, db);
  return hit ? rowToPublicView(hit.row) : null;
}

/** Best-effort "most-viewed" signal. Never throws into the read path. */
export async function bumpView(slug: string, db?: Db): Promise<void> {
  const s = normalizeSlug(slug);
  if (!s) return;
  try {
    const d = db ?? (await useDb());
    await d
      .update(lists)
      .set({ viewCount: sql`${lists.viewCount} + 1` })
      .where(and(eq(lists.publicSlug, s), ...publicReadConditions()));
  } catch {
    /* a view counter is never worth failing a page render */
  }
}

// The public-discovery visibility gate: the shared public-read gate PLUS
// non-empty (empty lists are hidden from discovery, not just de-ranked).
function publicVisibilityConditions() {
  return [...publicReadConditions(), gt(lists.itemCount, 0)];
}

/** Public list slugs for the sitemap — the public-discovery visibility gate. */
export async function listPublicSlugs(
  db?: Db,
): Promise<{ slug: string; updatedAt: Date | string | null }[]> {
  const d = db ?? (await useDb());
  return d
    .select({ slug: lists.publicSlug, updatedAt: lists.updatedAt })
    .from(lists)
    .where(and(...publicVisibilityConditions()))
    .orderBy(desc(lists.publishedAt))
    .limit(5000);
}

// ---------------------------------------------------------------------------
// Report — a public affordance to flag a list. Sets `flagged=true`, which
// WITHHOLDS the list from the public feed + /l read view pending review, but
// leaves `status='active'` so the OWNER keeps full edit + share access (/e, /s).
// So a malicious report can, at worst, pull a list out of public discovery — it
// can never lock an owner out of their own list (that needs an admin takedown to
// status='hidden'/'removed', which nothing user-facing does). Rate-limited at the
// endpoint; answers generically whether or not a row matched (no existence oracle).
// A single report no longer flags: the /api/lists/report endpoint requires a
// THRESHOLD of distinct reporters (IP-deduped via tallyDistinctReport) before it
// calls this, and restoreList() (admin-only) reverses a flag.
// ---------------------------------------------------------------------------
export async function reportList(slug: string, db?: Db): Promise<boolean> {
  const s = normalizeSlug(slug);
  if (!s) return false;
  const d = db ?? (await useDb());
  // publicReadConditions()'s `flagged = false` doubles as the idempotency guard
  // here — an already-flagged list matches nothing, so a re-report is a no-op.
  const res = await d
    .update(lists)
    .set({ flagged: true, updatedAt: new Date() })
    .where(and(eq(lists.publicSlug, s), ...publicReadConditions()))
    .returning(); // no-arg form (the union db type's only shared overload)
  return res.length > 0;
}

/**
 * Admin restore — clear a list's `flagged` so it returns to discovery. The
 * counterpart to reportList; deliberately NOT exposed to the owner's edit token,
 * because letting an owner self-clear would defeat moderation of genuine spam
 * (the same reason publishList keeps the flag sticky). Returns true if a row
 * changed. The endpoint gates this on GEAR_ADMIN_TOKEN.
 */
export async function restoreList(slug: string, db?: Db): Promise<boolean> {
  const s = normalizeSlug(slug);
  if (!s) return false;
  const d = db ?? (await useDb());
  const res = await d
    .update(lists)
    .set({ flagged: false, updatedAt: new Date() })
    .where(and(eq(lists.publicSlug, s), eq(lists.flagged, true), isNull(lists.deletedAt)))
    .returning();
  return res.length > 0;
}
