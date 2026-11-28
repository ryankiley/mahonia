// The seeder's upsert: every CSV row inserted, updated or left alone. Lives beside the
// seeder rather than in it so a test can run it on PGlite; seed-catalog.ts calls it
// after the renames and before the retire.
import { eq } from "drizzle-orm";
import { catalogItems } from "../server/db/schema";
import type { Db } from "../server/utils/db";
import { seedManaged } from "../shared/catalogQuality";
import { identity, type CatalogCsvRow } from "./catalogCsv";
import { serializeAttributes } from "./catalogAttributes";

/** Rows per INSERT: sixteen columns each, well under the driver's parameter ceiling. */
const INSERT_BATCH = 500;

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
 * so while the research still says what the seed last wrote from it (seed_weight_mg), the
 * corrected weight stays with the citation that backs it, the row's other fields still
 * follow the CSV, and it comes back in `kept` for an admin to verify or undo. Writing the
 * CSV over it used to undo the fix with no trace in the edit history. When the research
 * has moved, it wins. A community row the CSV claims takes the research's weight whatever
 * was done to it: the seed has never written it.
 *
 * seed_weight_mg and seed_source_url are the research's own weight and link, written here
 * and nowhere else, on every insert and update, a kept correction's row included: they
 * record what the research said, not what the row holds. A held row is not written at
 * all, so its pair still says what the research said before the verification, which is
 * how catalog:graduate tells a research edit made since (researchWhenVerified).
 *
 * The table is read ONCE and matched in memory. Matching each CSV row with its own
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
  const seeded = (row: CatalogCsvRow) => ({
    weightMg: row.weightMg,
    kcal: row.kcal,
    weightSource: row.weightSource,
    sourceUrl: row.sourceUrl,
    categoryHint: row.categoryHint,
    searchTerms: row.searchTerms,
    commonName: row.commonName,
    // the cell as the build writes it, so "unchanged" is a string compare
    attributes: (row.attributes && serializeAttributes(row.attributes)) || null,
    verified: true,
    verifiedBy: null,
    sourceQuote: null,
    seedWeightMg: row.weightMg,
    seedSourceUrl: row.sourceUrl,
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
    const seedMg = cur.seedWeightMg == null ? null : Number(cur.seedWeightMg);
    if (liveMg !== row.weightMg && seedMg === row.weightMg) {
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
      // the research moving is a change even to a row that already holds what it now says
      // (it adopted a correction): unrecorded, the next correction would read as one the
      // research had moved past
      seedMg !== want.seedWeightMg ||
      cur.seedSourceUrl !== want.seedSourceUrl ||
      cur.categoryHint !== want.categoryHint ||
      cur.searchTerms !== want.searchTerms ||
      cur.commonName !== want.commonName ||
      (cur.attributes ?? null) !== want.attributes ||
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
