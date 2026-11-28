// Fills seed_weight_mg and seed_source_url on a catalog that predates them. seed-catalog.ts
// calls it first, before the renames and the upsert read the pair. It does its work once
// per database and then answers null without reading the edit history; delete it, and its
// call, when the two columns fold into the CREATE.
import { and, eq, isNull, sql } from "drizzle-orm";
import { catalogEdits, catalogItems } from "../server/db/schema";
import type { Db } from "../server/utils/db";
import { seedManaged } from "../shared/catalogQuality";
import { identity, type CatalogCsvRow } from "./catalogCsv";

/** What one backfill wrote: the catalog ids of the rows it had to work out, and how many
 *  seed rows took their own weight and link. */
export interface SeedBackfill {
  /** rows verified in the app that began as research rows */
  inApp: number[];
  /** those of them whose verification replaced a weight the research doesn't say now: a
   *  visitor's correction, or research edited since, which the edit history can't tell apart */
  inAppDiffers: number[];
  /** seed rows holding a visitor's correction the research hasn't moved past */
  corrected: number[];
  /** every other seed row */
  seedRows: number;
}

/**
 * Before these columns, what the research last said of a row was worked out from the edit
 * history, so the history is read here one last time, with the CSV, to write it down:
 *
 * - A seed row takes its own weight and link: the seed wrote them, and nothing else has.
 * - A seed row whose weight came from visitors' corrections (an unbroken run of them ends
 *   at the weight it holds) and whose research still says a weight that run started from
 *   or passed through takes the research's weight and link, so the upsert keeps the
 *   correction. Any weight of the run, not only its first: a correction the research
 *   adopted, then a second one, is a correction to keep.
 * - A row verified in the app that was a research row before (an applied edit's undo
 *   snapshot has it verified with no verifier, a JSON null and not a missing key: the
 *   snapshot of a product the tool added has neither) takes the research's weight and link
 *   as the CSV has them, or what that snapshot replaced if the research no longer names it.
 *   What the snapshot replaced isn't always the research's (a visitor's correction the
 *   reseed had kept), so where the two differ the row is named in `inAppDiffers`.
 * - Every other row keeps none: a community row, a product added in the app.
 *
 * The rows that need the history are written first and the plain seed rows last, in one
 * statement, and a seed row without the pair is what says the backfill hasn't finished:
 * a run that dies part way is done again from the top, and each write is to a row still
 * without the pair. Written the other way round, a corrected row would be left saying the
 * research had said the corrected weight, and the next upsert would write over it.
 */
export async function backfillSeedColumns(db: Db, rows: readonly CatalogCsvRow[]): Promise<SeedBackfill | null> {
  const unfilled = await db
    .select({ id: catalogItems.id, brand: catalogItems.brand, name: catalogItems.name, variant: catalogItems.variant, weightMg: catalogItems.weightMg, verified: catalogItems.verified, verifiedBy: catalogItems.verifiedBy })
    .from(catalogItems)
    .where(isNull(catalogItems.seedWeightMg));
  if (!unfilled.some(seedManaged)) return null;

  const research = new Map(rows.map((row) => [identity(row.brand, row.name, row.variant), row]));
  const applied = new Map<number, { oldWeightMg: number; newWeightMg: number; correction: boolean; wasResearch: boolean; sourceUrl: string | null }[]>();
  const edits = await db
    .select({
      itemId: catalogEdits.catalogItemId,
      oldWeightMg: catalogEdits.oldWeightMg,
      newWeightMg: catalogEdits.newWeightMg,
      correction: sql<boolean>`${catalogEdits.undo} is null`,
      wasResearch: sql<boolean>`coalesce(${catalogEdits.undo}->>'verified' = 'true' and ${catalogEdits.undo}->'verifiedBy' = 'null'::jsonb, false)`,
      sourceUrl: sql<string | null>`${catalogEdits.undo}->>'sourceUrl'`,
    })
    .from(catalogEdits)
    .where(eq(catalogEdits.status, "applied"))
    .orderBy(catalogEdits.id);
  for (const { itemId, ...edit } of edits) {
    applied.getOrInsertComputed(itemId, () => []).push({ ...edit, oldWeightMg: Number(edit.oldWeightMg), newWeightMg: Number(edit.newWeightMg), correction: Boolean(edit.correction), wasResearch: Boolean(edit.wasResearch) });
  }

  const fill = (id: number, seedWeightMg: number, seedSourceUrl: string | null) =>
    db.update(catalogItems).set({ seedWeightMg, seedSourceUrl }).where(and(eq(catalogItems.id, id), isNull(catalogItems.seedWeightMg)));
  const inApp: number[] = [];
  const inAppDiffers: number[] = [];
  const corrected: number[] = [];
  for (const row of unfilled) {
    const history = applied.get(row.id) ?? [];
    const named = research.get(identity(row.brand, row.name, row.variant));
    if (row.verifiedBy != null) {
      const stamp = history.findLast((e) => e.wasResearch);
      if (!stamp) continue;
      await fill(row.id, named?.weightMg ?? stamp.oldWeightMg, named ? named.sourceUrl : stamp.sourceUrl);
      inApp.push(row.id);
      // (not a graduated row, whose research now says the app's weight)
      if (named && named.weightMg !== stamp.oldWeightMg && named.weightMg !== Number(row.weightMg)) inAppDiffers.push(row.id);
    } else if (seedManaged(row) && named && Number(row.weightMg) !== named.weightMg) {
      let weight = Number(row.weightMg);
      let kept = false;
      for (let i = history.length - 1; i >= 0 && !kept && history[i]!.correction && history[i]!.newWeightMg === weight; i--) {
        weight = history[i]!.oldWeightMg;
        kept = weight === named.weightMg;
      }
      if (!kept) continue;
      await fill(row.id, named.weightMg, named.sourceUrl);
      corrected.push(row.id);
    }
  }
  const plain = await db
    .update(catalogItems)
    .set({ seedWeightMg: sql`${catalogItems.weightMg}`, seedSourceUrl: sql`${catalogItems.sourceUrl}` })
    .where(and(eq(catalogItems.verified, true), isNull(catalogItems.verifiedBy), isNull(catalogItems.seedWeightMg)))
    .returning({ id: catalogItems.id });
  return { inApp, inAppDiffers, corrected, seedRows: plain.length };
}
