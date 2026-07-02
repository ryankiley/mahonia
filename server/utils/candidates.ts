// Community intake (Phase 3). Typed (non-catalog) list items are STAGED here on
// the list-save path (best-effort), then a nightly cron promotes any item seen on
// >= K distinct lists into a real community/unverified catalog_items row using the
// median observed weight — with a branded-item gate so generics ("tent", "snacks")
// never get in. The cited spine is never touched (community rows rank below it).

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { catalogCandidates, catalogItems } from "../db/schema";
import {
  classificationToCategory,
  isAcceptableTypedItem,
  isBrandedTypedItem,
  median,
  normKey,
  RANGE_G,
} from "../../shared/catalogQuality";
import { itemDisplayName } from "../../shared/weights";
import { bumpUsage, ensureCatalogSchema, searchCatalog, trigramScore } from "./catalog";

type Db = { execute: (q: unknown) => Promise<unknown>; [k: string]: unknown } & any;

export const K_DISTINCT_LISTS = Math.max(2, Number(process.env.CATALOG_MIN_DISTINCT_LISTS) || 3);
const DEDUP_THRESHOLD = 0.6; // 2x the autocomplete recall floor — bias to a new (recoverable) row
const MIN_WEIGHTS = 2; // need at least this many corroborating weights to set a community weight

export const CANDIDATES_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS catalog_candidates (
    id serial PRIMARY KEY,
    norm_key text NOT NULL,
    raw_brand text,
    raw_name text NOT NULL,
    list_id integer NOT NULL,
    weight_mg bigint,
    classification text,
    promoted_into_id integer,
    rejected_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_identity ON catalog_candidates (norm_key, list_id)`,
  `CREATE INDEX IF NOT EXISTS idx_candidate_open ON catalog_candidates (norm_key) WHERE promoted_into_id IS NULL AND rejected_at IS NULL`,
];

let _ensured: Promise<void> | undefined;
export function ensureCandidatesSchema(db: unknown): Promise<void> {
  const d = db as { execute: (q: unknown) => Promise<unknown> };
  if (!_ensured) {
    _ensured = (async () => {
      for (const stmt of CANDIDATES_DDL) await d.execute(sql.raw(stmt));
    })().catch((e) => {
      _ensured = undefined;
      throw e;
    });
  }
  return _ensured;
}

export interface CandidateObservation {
  brand?: string | null;
  name: string;
  weightMg?: number | null;
  classification?: string | null;
}

/** Stage typed items from one list. Best-effort + capped; callers wrap in try/catch. */
export async function stageCandidates(
  db: Db,
  listId: number,
  obs: CandidateObservation[],
): Promise<void> {
  const rows = obs
    .filter((o) => o.name && isAcceptableTypedItem({ brand: o.brand, name: o.name }))
    .slice(0, 50)
    .map((o) => ({
      normKey: normKey([o.brand, o.name].filter(Boolean).join(" ")),
      rawBrand: o.brand?.trim() || null,
      rawName: o.name.trim(),
      listId,
      weightMg: typeof o.weightMg === "number" && o.weightMg > 0 ? Math.round(o.weightMg) : null,
      classification: o.classification ?? null,
    }))
    .filter((r) => r.normKey);
  if (!rows.length) return;
  await ensureCandidatesSchema(db);
  // Dedupe by the upsert key (last observation wins): two staged rows sharing a
  // normKey inside ONE multi-row INSERT would raise Postgres's "ON CONFLICT DO
  // UPDATE command cannot affect row a second time". listId is constant here, so
  // normKey alone is the key.
  const deduped = [...new Map(rows.map((r) => [r.normKey, r])).values()];
  // One multi-row upsert = one round trip (neon-http sends one query per fetch,
  // so the previous per-row loop cost up to 50 sequential round trips on the
  // list-save path). `excluded.*` pulls each conflicting row's own values.
  await db
    .insert(catalogCandidates)
    .values(deduped)
    .onConflictDoUpdate({
      target: [catalogCandidates.normKey, catalogCandidates.listId],
      set: {
        rawBrand: sql`excluded.raw_brand`,
        rawName: sql`excluded.raw_name`,
        weightMg: sql`excluded.weight_mg`,
        classification: sql`excluded.classification`,
        updatedAt: new Date(),
      },
    });
}

const mode = <T>(arr: T[]): T | undefined => {
  const m = new Map<T, number>();
  let best: T | undefined, bc = 0;
  for (const x of arr) {
    const c = (m.get(x) ?? 0) + 1;
    m.set(x, c);
    if (c > bc) { bc = c; best = x; }
  }
  return best;
};

export interface CorroborateResult {
  scanned: number; promoted: number; merged: number; rejected: number; skipped: number; purged: number;
}

/** The nightly job: promote corroborated typed items into community catalog rows. */
export async function corroborateCatalog(db: Db): Promise<CorroborateResult> {
  await ensureCatalogSchema(db);
  await ensureCandidatesSchema(db);
  const res: CorroborateResult = { scanned: 0, promoted: 0, merged: 0, rejected: 0, skipped: 0, purged: 0 };

  // norm_keys corroborated by >= K distinct lists
  const promotable = await db
    .select({ normKey: catalogCandidates.normKey })
    .from(catalogCandidates)
    .where(and(isNull(catalogCandidates.promotedIntoId), isNull(catalogCandidates.rejectedAt)))
    .groupBy(catalogCandidates.normKey)
    .having(sql`count(distinct ${catalogCandidates.listId}) >= ${K_DISTINCT_LISTS}`);
  const keys = promotable.map((p: { normKey: string }) => p.normKey);
  res.scanned = keys.length;
  if (!keys.length) return res;

  // all open observations for those keys, grouped in JS
  const rows = (await db
    .select()
    .from(catalogCandidates)
    .where(and(inArray(catalogCandidates.normKey, keys), isNull(catalogCandidates.promotedIntoId), isNull(catalogCandidates.rejectedAt)))) as Array<{
    normKey: string; rawBrand: string | null; rawName: string; listId: number; weightMg: number | null; classification: string | null;
  }>;
  const groups = new Map<string, typeof rows>();
  for (const r of rows) (groups.get(r.normKey) ?? groups.set(r.normKey, []).get(r.normKey)!).push(r);

  // known catalog brands (for the branded-item gate)
  const brandRows = await db.selectDistinct({ brand: catalogItems.brand }).from(catalogItems).where(eq(catalogItems.status, "active"));
  const knownBrands = new Set<string>(
    brandRows.map((b: { brand: string | null }) => normKey(b.brand)).filter((s: string) => s.length > 0),
  );

  const reject = async (key: string) => {
    await db.update(catalogCandidates).set({ rejectedAt: new Date() })
      .where(and(eq(catalogCandidates.normKey, key), isNull(catalogCandidates.promotedIntoId), isNull(catalogCandidates.rejectedAt)));
  };
  const markPromoted = async (key: string, id: number) => {
    await db.update(catalogCandidates).set({ promotedIntoId: id })
      .where(and(eq(catalogCandidates.normKey, key), isNull(catalogCandidates.promotedIntoId), isNull(catalogCandidates.rejectedAt)));
  };

  for (const [key, grp] of groups) {
    const rawName = mode(grp.map((r) => r.rawName))!;
    const rawBrand = mode(grp.filter((r) => r.rawBrand).map((r) => r.rawBrand!)) ?? null;
    const full = [rawBrand, rawName].filter(Boolean).join(" ");

    // gates: clean + branded
    if (!isAcceptableTypedItem({ brand: rawBrand, name: rawName }) || !isBrandedTypedItem({ brand: rawBrand, name: rawName, knownBrands })) {
      await reject(key); res.rejected++; continue;
    }
    // corroborated, plausible weight
    const weights = grp.map((r) => r.weightMg).filter((w): w is number => typeof w === "number" && w > 0);
    if (weights.length < MIN_WEIGHTS) { res.skipped++; continue; } // leave open for more data
    const med = median(weights);
    const category = classificationToCategory(mode(grp.map((r) => r.classification).filter(Boolean) as string[]) ?? null);
    const [lo, hi] = RANGE_G[category] ?? RANGE_G.other ?? ([0, Number.MAX_SAFE_INTEGER] as [number, number]);
    if (med / 1000 < lo || med / 1000 > hi) { await reject(key); res.rejected++; continue; }

    // dedup against the live catalog (fuzzy) → bump usage instead of duplicating
    const matches = await searchCatalog(db, full, 5);
    let bestId = 0, bestScore = 0;
    for (const m of matches) {
      const s = trigramScore(full, itemDisplayName(m.brand, m.name));
      if (s > bestScore) { bestScore = s; bestId = m.id; }
    }
    if (bestScore >= DEDUP_THRESHOLD && bestId) {
      await bumpUsage(db, [bestId]);
      await markPromoted(key, bestId);
      res.merged++;
      continue;
    }

    // else create a new community (unverified) row
    const lists = new Set(grp.map((r) => r.listId)).size;
    try {
      const ins = await db.insert(catalogItems).values({
        brand: rawBrand, name: rawName, variant: null, categoryHint: category,
        weightMg: med, weightSource: "community", verified: false, status: "active", usageCount: lists,
      }).returning({ id: catalogItems.id });
      await markPromoted(key, ins[0]!.id);
      res.promoted++;
    } catch {
      res.skipped++; // identity collision or transient — leave open
    }
  }

  // retention: drop raw typed text after 90 days (it can contain PII)
  const purged = await db.delete(catalogCandidates)
    .where(sql`${catalogCandidates.createdAt} < now() - interval '90 days'`)
    .returning({ id: catalogCandidates.id });
  res.purged = Array.isArray(purged) ? purged.length : 0;
  return res;
}
