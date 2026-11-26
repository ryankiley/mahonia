// The seeder's upsert: every CSV row inserted, updated or left alone. Lives beside the
// seeder rather than in it so a test can run it on PGlite; seed-catalog.ts calls it
// after the renames and before the retire.
import { eq, sql } from "drizzle-orm";
import { catalogEdits, catalogItems } from "../server/db/schema";
import type { Db } from "../server/utils/db";
import { seedManaged } from "../shared/catalogQuality";
import { identity, type CatalogCsvRow } from "./catalogCsv";

/** Rows per INSERT: eleven columns each, well under the driver's parameter ceiling. */
const INSERT_BATCH = 500;

/** One applied weight change on a row, as catalog_edits holds it. `correction` is a
 *  visitor's fix (no undo); the rest are an admin's in-app verifications. */
export interface AppliedEdit {
  oldWeightMg: number;
  newWeightMg: number;
  correction: boolean;
}

/**
 * The weight a row held before the visitors' corrections that brought it to `liveMg`, or
 * null when its weight didn't come from one. `applied` is the row's applied edits, oldest
 * first. Walked newest first, each must be a correction that set the weight the walk is
 * holding; the first that isn't marks another writer in between (a reseed whose research
 * had moved, an admin's verification), so the walk stops there.
 */
export function weightBeforeCorrections(liveMg: number, applied: readonly AppliedEdit[]): number | null {
  let weight = liveMg;
  let walked = false;
  for (let i = applied.length - 1; i >= 0 && applied[i]!.correction && applied[i]!.newWeightMg === weight; i--) {
    weight = applied[i]!.oldWeightMg;
    walked = true;
  }
  return walked ? weight : null;
}

/** A visitor's correction the upsert left standing over the research's weight. */
export interface KeptCorrection {
  id: number;
  brand: string | null;
  name: string;
  variant: string | null;
  researchMg: number;
  liveMg: number;
  sourceUrl: string | null;
}

/**
 * Bring catalog_items to the CSV: a row the table doesn't hold is inserted, a row whose
 * seeded fields moved is updated in place (id kept), and the rest are left alone. A
 * retired row the research names again comes back under its old id, so the lists that
 * never stopped holding that id pick it up where they left off. Seeded rows are
 * owner-curated and cited, so they are written verified. A row an admin verified in the
 * app that the research now names is taken over the same way: id kept, its verifier and
 * quote cleared, the seed's from here on, once the research agrees with it on the weight,
 * its source and its link, which is what catalog:graduate writes back. Until then the row
 * is held: left as it is, and counted. It is newer than the research: a research row
 * whose maker re-specced it, corrected with verify_catalog_item, would otherwise get its
 * old weight back on the next reseed. A retired row isn't held; the research brings it
 * back as before.
 *
 * A visitor's correction is kept too, more narrowly. A research row takes one live when it
 * cites a trusted source (proposeCorrection), and nothing writes it back to the research,
 * so while the research still says what the row said before it, the corrected weight stays
 * with the citation that backs it, the row's other fields still follow the CSV, and it
 * comes back in `kept` for an admin to verify or undo. Writing the CSV over it used to undo
 * the fix with no trace in the edit history. When the research has moved, it wins. A
 * community row the CSV claims takes the research's weight whatever was done to it.
 *
 * The tables are read ONCE and matched in memory. Matching each CSV row with its own
 * SELECT was some four thousand round trips to Neon per reseed, minutes of a run that
 * usually changes a handful of rows.
 */
export async function upsertSeedRows(
  db: Db,
  rows: readonly CatalogCsvRow[],
): Promise<{ inserted: number; updated: number; unchanged: number; held: number; kept: KeptCorrection[] }> {
  const byIdentity = new Map(
    (await db.select().from(catalogItems)).map((r) => [identity(r.brand, r.name, r.variant), r]),
  );
  const applied = new Map<number, AppliedEdit[]>();
  const edits = await db
    .select({
      itemId: catalogEdits.catalogItemId,
      oldWeightMg: catalogEdits.oldWeightMg,
      newWeightMg: catalogEdits.newWeightMg,
      correction: sql<boolean>`${catalogEdits.undo} is null`,
    })
    .from(catalogEdits)
    .where(eq(catalogEdits.status, "applied"))
    .orderBy(catalogEdits.id);
  for (const { itemId, oldWeightMg, newWeightMg, correction } of edits) {
    const edit = { oldWeightMg: Number(oldWeightMg), newWeightMg: Number(newWeightMg), correction: Boolean(correction) };
    (applied.get(itemId) ?? applied.set(itemId, []).get(itemId)!).push(edit);
  }
  const seeded = (row: CatalogCsvRow) => ({
    weightMg: row.weightMg,
    kcal: row.kcal,
    weightSource: row.weightSource,
    sourceUrl: row.sourceUrl,
    categoryHint: row.categoryHint,
    searchTerms: row.searchTerms,
    commonName: row.commonName,
    verified: true,
    verifiedBy: null,
    sourceQuote: null,
  });

  const fresh: (typeof catalogItems.$inferInsert)[] = [];
  const kept: KeptCorrection[] = [];
  let updated = 0;
  let unchanged = 0;
  let held = 0;
  // keyed first, so a CSV that named one identity twice writes it once (the later row
  // wins, as it did when each row was its own statement)
  const wanted = new Map(rows.map((row) => [identity(row.brand, row.name, row.variant), row]));
  for (const [key, row] of wanted) {
    const cur = byIdentity.get(key);
    if (!cur) {
      fresh.push({ brand: row.brand, name: row.name, variant: row.variant, ...seeded(row) });
      continue;
    }
    if (
      cur.verifiedBy != null &&
      cur.status === "active" &&
      (Number(cur.weightMg) !== row.weightMg || cur.weightSource !== row.weightSource || cur.sourceUrl !== row.sourceUrl)
    ) {
      held++;
      continue;
    }
    const want = seeded(row);
    const liveMg = Number(cur.weightMg);
    if (cur.verified && liveMg !== row.weightMg && weightBeforeCorrections(liveMg, applied.get(cur.id) ?? []) === row.weightMg) {
      // the citation goes with the weight it cites
      want.weightMg = liveMg;
      want.sourceUrl = cur.sourceUrl;
      kept.push({ id: cur.id, brand: cur.brand, name: cur.name, variant: cur.variant, researchMg: row.weightMg, liveMg, sourceUrl: cur.sourceUrl });
    }
    const changed =
      liveMg !== want.weightMg ||
      (cur.kcal ?? null) !== want.kcal ||
      cur.weightSource !== want.weightSource ||
      cur.sourceUrl !== want.sourceUrl ||
      cur.categoryHint !== want.categoryHint ||
      cur.searchTerms !== want.searchTerms ||
      cur.commonName !== want.commonName ||
      !seedManaged(cur) ||
      cur.status !== "active";
    if (!changed) {
      unchanged++;
      continue;
    }
    await db
      .update(catalogItems)
      .set({ ...want, status: "active", mergedIntoId: null, updatedAt: new Date() })
      .where(eq(catalogItems.id, cur.id));
    updated++;
  }
  for (let i = 0; i < fresh.length; i += INSERT_BATCH) {
    await db.insert(catalogItems).values(fresh.slice(i, i + INSERT_BATCH));
  }
  return { inserted: fresh.length, updated, unchanged, held, kept };
}
