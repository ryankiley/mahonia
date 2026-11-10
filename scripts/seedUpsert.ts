// The seeder's upsert: every CSV row inserted, updated or left alone. Lives beside the
// seeder rather than in it so a test can run it on PGlite; seed-catalog.ts calls it
// after the renames and before the retire.
import { eq } from "drizzle-orm";
import { catalogItems } from "../server/db/schema";
import type { Db } from "../server/utils/db";
import type { CatalogCsvRow } from "./catalogCsv";

const SEP = "\u0000";
/** A row's identity, as the table's unique index reads it: an absent brand or variant
 *  is the empty one. */
export const identity = (brand: string | null, name: string, variant: string | null) =>
  `${brand ?? ""}${SEP}${name}${SEP}${variant ?? ""}`;

/** Rows per INSERT: eleven columns each, well under the driver's parameter ceiling. */
const INSERT_BATCH = 500;

/**
 * Bring catalog_items to the CSV: a row the table doesn't hold is inserted, a row whose
 * seeded fields moved is updated in place (id kept), and the rest are left alone. A
 * retired row the research names again comes back under its old id, so the lists that
 * never stopped holding that id pick it up where they left off. Seeded rows are
 * owner-curated and cited, so they are written verified.
 *
 * The table is read ONCE and matched in memory. Matching each CSV row with its own
 * SELECT was some four thousand round trips to Neon per reseed, minutes of a run that
 * usually changes a handful of rows.
 */
export async function upsertSeedRows(
  db: Db,
  rows: readonly CatalogCsvRow[],
): Promise<{ inserted: number; updated: number; unchanged: number }> {
  const held = new Map(
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
    verified: true,
  });

  const fresh: (typeof catalogItems.$inferInsert)[] = [];
  let updated = 0;
  let unchanged = 0;
  // keyed first, so a CSV that named one identity twice writes it once (the later row
  // wins, as it did when each row was its own statement)
  const wanted = new Map(rows.map((row) => [identity(row.brand, row.name, row.variant), row]));
  for (const [key, row] of wanted) {
    const cur = held.get(key);
    if (!cur) {
      fresh.push({ brand: row.brand, name: row.name, variant: row.variant, ...seeded(row) });
      continue;
    }
    const changed =
      Number(cur.weightMg) !== row.weightMg ||
      (cur.kcal ?? null) !== row.kcal ||
      cur.weightSource !== row.weightSource ||
      cur.sourceUrl !== row.sourceUrl ||
      cur.categoryHint !== row.categoryHint ||
      cur.searchTerms !== row.searchTerms ||
      cur.commonName !== row.commonName ||
      cur.verified !== true ||
      cur.status !== "active";
    if (!changed) {
      unchanged++;
      continue;
    }
    await db
      .update(catalogItems)
      .set({ ...seeded(row), status: "active", mergedIntoId: null, updatedAt: new Date() })
      .where(eq(catalogItems.id, cur.id));
    updated++;
  }
  for (let i = 0; i < fresh.length; i += INSERT_BATCH) {
    await db.insert(catalogItems).values(fresh.slice(i, i + INSERT_BATCH));
  }
  return { inserted: fresh.length, updated, unchanged };
}
