// Community intake (Phase 3). Typed (non-catalog) list items are STAGED here on
// the list-save path (best-effort), then a nightly cron promotes any item seen on
// >= K distinct lists into a real community/unverified catalog_items row using the
// median observed weight — with a branded-item gate so generics ("tent", "snacks")
// never get in. The cited spine is never touched (community rows rank below it).

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { catalogCandidates, catalogItems } from "../db/schema";
import {
  categoryForGearType,
  classificationToCategory,
  emergingBrandTokens,
  GENERIC_GEAR_TERMS,
  isAcceptableTypedItem,
  isBrandedTypedItem,
  median,
  normalizeVariant,
  normKey,
  RANGE_G,
  splitKnownBrand,
} from "../../shared/catalogQuality";
import { itemDisplayName } from "../../shared/weights";
import { bumpUsage, ensureCatalogSchema, searchCatalog, trigramScore } from "./catalog";
import { memoized } from "./memoize";
import type { Db } from "./db";

const K_DISTINCT_LISTS = Math.max(2, Number(process.env.CATALOG_MIN_DISTINCT_LISTS) || 3);
const DEDUP_THRESHOLD = 0.6; // 2x the autocomplete recall floor — bias to a new (recoverable) row
const MIN_WEIGHTS = 2; // need at least this many corroborating weights to set a community weight

export const CANDIDATES_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS catalog_candidates (
    id serial PRIMARY KEY,
    norm_key text NOT NULL,
    raw_brand text,
    raw_name text NOT NULL,
    raw_variant text,
    raw_common_name text,
    list_id integer NOT NULL,
    weight_mg bigint,
    classification text,
    promoted_into_id integer,
    rejected_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // the size or version column arrived after the table did (2026-09-12); a database
  // that already has the table takes it here, the same way the catalog table grows
  `ALTER TABLE catalog_candidates ADD COLUMN IF NOT EXISTS raw_variant text`,
  `ALTER TABLE catalog_candidates ADD COLUMN IF NOT EXISTS raw_common_name text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_identity ON catalog_candidates (norm_key, list_id)`,
  `CREATE INDEX IF NOT EXISTS idx_candidate_open ON catalog_candidates (norm_key) WHERE promoted_into_id IS NULL AND rejected_at IS NULL`,
];

const ensureCandidatesSchema = memoized(async (db: Db) => {
  for (const stmt of CANDIDATES_DDL) await db.execute(sql.raw(stmt));
});

export interface CandidateObservation {
  brand?: string | null;
  name: string;
  // the typed size or version. Part of the identity: a Long and a Regular of the same
  // quilt are two products with two weights, and one blended community row for both
  // would be wrong for either (the catalog's own identity index is brand+name+variant)
  variant?: string | null;
  // the typed gear type ("Tent"): the promoted row's common_name, so a later pick
  // fills the field, and its search term, so "tent" finds it; and the plausibility
  // band, which the class alone cannot pick (see categoryForGearType)
  commonName?: string | null;
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
      normKey: normKey(itemDisplayName(o.brand, o.name, o.variant)),
      rawBrand: o.brand?.trim() || null,
      rawName: o.name.trim(),
      rawVariant: o.variant?.trim() || null,
      rawCommonName: o.commonName?.trim() || null,
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
        rawVariant: sql`excluded.raw_variant`,
        rawCommonName: sql`excluded.raw_common_name`,
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

interface CorroborateResult {
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
  // Retention is independent of whether anything is promotable today. In
  // particular, one-off observations never reach K, which used to make their
  // raw typed text live forever because this early return skipped the purge.
  const purgeExpired = async () => {
    const purged = await db.delete(catalogCandidates)
      .where(sql`${catalogCandidates.createdAt} < now() - interval '90 days'`)
      .returning();
    return purged.length;
  };
  if (!keys.length) {
    res.purged = await purgeExpired();
    return res;
  }

  // all open observations for those keys, grouped in JS
  const rows = (await db
    .select()
    .from(catalogCandidates)
    .where(and(inArray(catalogCandidates.normKey, keys), isNull(catalogCandidates.promotedIntoId), isNull(catalogCandidates.rejectedAt)))) as Array<{
    normKey: string; rawBrand: string | null; rawName: string; rawVariant: string | null; rawCommonName: string | null; listId: number; weightMg: number | null; classification: string | null;
  }>;
  const groups = new Map<string, typeof rows>();
  for (const r of rows) (groups.get(r.normKey) ?? groups.set(r.normKey, []).get(r.normKey)!).push(r);

  // known catalog brands: the branded-item gate reads the folded set, and the split
  // below wants the catalog's own spelling for each ("Sea to Summit", not "sea to summit")
  const brandRows = await db.selectDistinct({ brand: catalogItems.brand }).from(catalogItems).where(eq(catalogItems.status, "active"));
  const brandSpellings = new Map<string, string>();
  for (const b of brandRows as { brand: string | null }[]) {
    const key = normKey(b.brand);
    if (key && !brandSpellings.has(key)) brandSpellings.set(key, b.brand!.trim());
  }
  const knownBrands = new Set<string>(brandSpellings.keys());

  // A new maker must head at least two independently corroborated candidate names.
  // Let Postgres narrow the 90-day intake table to those names first; the small result
  // is all the pure helper needs to decide which leading tokens are trustworthy.
  const emergingRows = await db
    .select({
      normKey: catalogCandidates.normKey,
      rawName: sql<string>`min(${catalogCandidates.rawName})`,
    })
    .from(catalogCandidates)
    .where(and(isNull(catalogCandidates.promotedIntoId), isNull(catalogCandidates.rejectedAt)))
    .groupBy(catalogCandidates.normKey)
    .having(sql`count(distinct ${catalogCandidates.listId}) >= 2`);
  const emergingBrands = emergingBrandTokens(
    // Candidate identity includes variant, but brand evidence is per PRODUCT: two
    // sizes of "Frobozz Megapack" corroborate one name, not two makers' products.
    emergingRows.map((row) => ({ normKey: normKey(row.rawName), name: row.rawName })),
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
    const typedName = mode(grp.map((r) => r.rawName))!;
    const typedBrand = mode(grp.filter((r) => r.rawBrand).map((r) => r.rawBrand!)) ?? null;
    // A typed row carries its brand inside the name ("Zpacks Duplex": no brand field
    // on a typed row), so a known brand at the front is split out here, spelled as the
    // catalog spells it, and the community row lands shaped like the cited ones. A
    // row that came with a brand of its own keeps it.
    const split = typedBrand
      ? { brand: typedBrand, name: typedName }
      : splitKnownBrand(typedName, brandSpellings, emergingBrands);
    const rawBrand = split.brand;
    const rawName = split.name;
    // the typed size or version, in the catalog's one style ("Long, 18F"), or none
    const variant = normalizeVariant(mode(grp.filter((r) => r.rawVariant).map((r) => r.rawVariant!)) ?? null) || null;
    const full = itemDisplayName(rawBrand, rawName, variant);

    // gates: clean + branded (the gate reads the name as typed, brand and all)
    if (!isAcceptableTypedItem({ brand: typedBrand, name: typedName }) || !isBrandedTypedItem({ brand: typedBrand, name: typedName, knownBrands, emergingBrands })) {
      await reject(key); res.rejected++; continue;
    }
    // corroborated, plausible weight
    const weights = grp.map((r) => r.weightMg).filter((w): w is number => typeof w === "number" && w > 0);
    if (weights.length < MIN_WEIGHTS) { res.skipped++; continue; } // leave open for more data
    const med = median(weights);
    // the plausibility band: the typed gear type where it names one ("Tent": up to
    // 3.5 kg), else the class ("other" tops out at 1.6 kg, which rejected a typed
    // 1.7 kg tent for good)
    const commonName = mode(grp.filter((r) => r.rawCommonName).map((r) => r.rawCommonName!)) ?? null;
    const category = categoryForGearType(commonName) ?? classificationToCategory(mode(grp.map((r) => r.classification).filter(Boolean) as string[]) ?? null);
    const [lo, hi] = RANGE_G[category] ?? RANGE_G.other ?? ([0, Number.MAX_SAFE_INTEGER] as [number, number]);
    if (med / 1000 < lo || med / 1000 > hi) { await reject(key); res.rejected++; continue; }

    // dedup against the live catalog (fuzzy) → bump usage instead of duplicating.
    // A candidate WITH a size or version only ever merges into a row of that size: the
    // names alone score two sizes of one product as duplicates of each other, and the
    // Regular would have merged into whichever size was promoted first. A candidate
    // without one may still merge into any size of the product, as it always did (a
    // usage bump on one of them beats a sizeless community row beside the cited ones).
    // And a typed name that says MORE than the catalog row is a different product, not
    // a duplicate: trigramScore is coverage of the query's trigrams by the target, so
    // "Zpacks Duplex Zip" scored its parent "Duplex" at about 0.75 and was merged into
    // it, and the sibling product never entered. A word the row lacks refuses the
    // merge; a generic noun the person added ("tent") is not such a word.
    const matches = await searchCatalog(db, full, 5);
    const sizeKey = normKey(variant);
    const tokensOf = (t: string) => normKey(t).split(" ").filter(Boolean);
    const said = tokensOf(full).filter((t) => !GENERIC_GEAR_TERMS.has(t));
    let bestId = 0, bestScore = 0;
    for (const m of matches) {
      if (sizeKey && normKey(m.variant) !== sizeKey) continue;
      const target = itemDisplayName(m.brand, m.name, m.variant);
      const has = new Set(tokensOf(target));
      if (said.some((t) => !has.has(t))) continue;
      const s = trigramScore(full, target);
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
        brand: rawBrand, name: rawName, variant, categoryHint: category,
        // the typed gear type, as the row's gear type for the next pick and as its
        // search term, since the search matches brand + name + search_terms and
        // "tent" would otherwise never find a community "Duplex Zip"
        commonName, searchTerms: commonName ? normKey(commonName) || null : null,
        weightMg: med, weightSource: "community", verified: false, status: "active", usageCount: lists,
      }).returning();
      await markPromoted(key, ins[0]!.id);
      res.promoted++;
    } catch {
      res.skipped++; // identity collision or transient — leave open
    }
  }

  // retention: drop raw typed text after 90 days (it can contain PII)
  res.purged = await purgeExpired();
  return res;
}
