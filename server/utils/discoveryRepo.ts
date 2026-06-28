// Discovery + publish repository — all DB access for the PUBLIC surfaces
// (the feed, the /l/[slug] read view, the publish toggle, list reports).
//
// Capability-based, exactly like listRepo.ts: a writer holds an edit token, the
// public reads address a list by its slug. The internal numeric `id` and the
// `edit_token_hash` NEVER leave this module — feed cards and the public view
// expose only `public_slug` + `share_code`, so the edit capability can't be
// derived from anything public. Misses return null → the endpoints answer 404
// (never 403), so there's no existence/enumeration oracle.
//
// Each function takes an OPTIONAL db (defaults to useDb()) so the query logic
// is exercisable against an in-memory PGlite in tests — endpoints call the
// no-arg form. The decision logic itself lives in shared/discovery.ts.
//
// Lives in its own file (not listRepo.ts) so this Phase-3 work stays additive
// and merge-clean alongside the concurrent rate-limiter + component sessions.

import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { lists, type ListRow } from "../db/schema";
import {
  cardFromRow,
  decidePublish,
  normalizeSeason,
  normalizeTripType,
  type DiscoveryCard,
  type FeedView,
  type PublishState,
} from "../../shared/discovery";
import type { ListData, ListSnapshot } from "../../shared/types";
import { useDb } from "./db";
import { rowToSnapshot } from "./listRepo";
import { sha256Hex } from "./tokens";

type Db = Awaited<ReturnType<typeof useDb>>;

// Public addresses look like `{slug}-{6 crockford}`, lowercased. Validate the
// shape before any DB round-trip (and to keep obviously-junk input out).
const SLUG_RE = /^[a-z0-9-]{1,80}$/;
function normalizeSlug(raw: string): string | null {
  const s = (raw || "").trim().toLowerCase();
  return SLUG_RE.test(s) ? s : null;
}

const liveByEditToken = (hash: string) =>
  and(eq(lists.editTokenHash, hash), eq(lists.status, "active"), isNull(lists.deletedAt));

async function findRowByEditToken(db: Db, editToken: string): Promise<ListRow | null> {
  const rows = await db.select().from(lists).where(liveByEditToken(sha256Hex(editToken))).limit(1);
  return rows[0] ?? null;
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

/** Current publish state for the editor's modal to prefill. Null → 404. */
export async function getPublishState(editToken: string, db?: Db): Promise<PublishState | null> {
  const d = db ?? (await useDb());
  const row = await findRowByEditToken(d, editToken);
  return row ? publicState(row) : null;
}

/**
 * Set a list public/private + its feed facets. The decision (spam→hidden,
 * stamp-once published_at, no resurrecting a moderated list) is decidePublish()
 * in shared/. Only the public address is returned.
 */
export async function publishList(
  editToken: string,
  input: { isPublic: boolean; tripType?: string | null; season?: string | null },
  db?: Db,
): Promise<PublishState | null> {
  const d = db ?? (await useDb());
  const row = await findRowByEditToken(d, editToken);
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

// ---------------------------------------------------------------------------
// Public read view (/l/[slug]) — resolves ONLY if the list is public. Returns a
// ListSnapshot-shaped view (reuses the readonly FolderSection/ItemRow/TotalsBar)
// minus the id + token. Null → 404.
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

export async function getPublicBySlug(slug: string, db?: Db): Promise<ListSnapshot | null> {
  const s = normalizeSlug(slug);
  if (!s) return null;
  const d = db ?? (await useDb());
  const rows = await d
    .select()
    .from(lists)
    .where(
      and(
        eq(lists.publicSlug, s),
        eq(lists.isPublic, true),
        eq(lists.status, "active"),
        eq(lists.flagged, false),
        isNull(lists.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ? rowToPublicView(rows[0]) : null;
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
      .where(
        and(
          eq(lists.publicSlug, s),
          eq(lists.isPublic, true),
          eq(lists.status, "active"),
          eq(lists.flagged, false),
          isNull(lists.deletedAt),
        ),
      );
  } catch {
    /* a view counter is never worth failing a page render */
  }
}

// ---------------------------------------------------------------------------
// The feed query. Always: public + active + not-deleted + NON-EMPTY (empty
// lists are hidden, not just de-ranked). Optional trip/season filters. Sort by
// view. `light` is the optional leaderboard — only weighted lists, base asc.
// ---------------------------------------------------------------------------
export interface FeedQuery {
  view?: FeedView;
  tripType?: string | null;
  season?: string | null;
  limit?: number;
}

// The public-discovery visibility gate, single-sourced so the feed + sitemap
// can't drift: public, active, not withheld (reported / spam-flagged), not
// deleted, and non-empty (empty lists are hidden, not just de-ranked).
function publicVisibilityConditions() {
  return [
    eq(lists.isPublic, true),
    eq(lists.status, "active"),
    eq(lists.flagged, false),
    isNull(lists.deletedAt),
    gt(lists.itemCount, 0),
  ];
}

export async function getFeed(q: FeedQuery, db?: Db): Promise<DiscoveryCard[]> {
  const d = db ?? (await useDb());
  const view: FeedView = q.view ?? "recent";
  const limit = Math.min(60, Math.max(1, Math.floor(q.limit || 24)));

  const conds = publicVisibilityConditions();
  const trip = normalizeTripType(q.tripType);
  if (trip) conds.push(eq(lists.tripType, trip));
  const season = normalizeSeason(q.season);
  if (season) conds.push(eq(lists.season, season));
  // the leaderboard only ranks lists that actually carry weight
  if (view === "light") conds.push(gt(lists.baseWeightMg, 0));

  const orderBy =
    view === "light"
      ? [asc(lists.baseWeightMg)]
      : view === "popular"
        ? [desc(lists.viewCount), desc(lists.publishedAt)]
        : [desc(lists.publishedAt)];

  const rows = await d
    .select({
      publicSlug: lists.publicSlug,
      shareCode: lists.shareCode,
      title: lists.title,
      itemCount: lists.itemCount,
      tripType: lists.tripType,
      season: lists.season,
      baseWeightMg: lists.baseWeightMg,
      totalWeightMg: lists.totalWeightMg,
      publishedAt: lists.publishedAt,
      data: lists.data,
    })
    .from(lists)
    .where(and(...conds))
    .orderBy(...orderBy)
    .limit(limit);

  return rows.map((r) =>
    cardFromRow({ ...r, data: (r.data ?? { folders: [], items: [] }) as ListData }),
  );
}

/** Public list slugs for the sitemap — same visibility gate as the feed. */
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
  const res = await d
    .update(lists)
    .set({ flagged: true, updatedAt: new Date() })
    .where(
      and(
        eq(lists.publicSlug, s),
        eq(lists.isPublic, true),
        eq(lists.status, "active"),
        eq(lists.flagged, false), // first report only → idempotent
        isNull(lists.deletedAt),
      ),
    )
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
