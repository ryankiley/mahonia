// A catalog row the research stops naming is retired, never deleted (2026-10-31). Lives
// beside the seeder rather than in it so a test can run it on PGlite; seed-catalog.ts
// calls it after its upsert, in place of the old prune.
import { eq } from "drizzle-orm";
import { catalogItems } from "../server/db/schema";
import { matchSuccessor } from "../shared/catalogLinks";
import type { useDb } from "../server/utils/db";
import type { CatalogCsvRow } from "./catalogCsv";

type Db = Awaited<ReturnType<typeof useDb>>;

const SEP = "\u0000";
const identity = (brand: string | null, name: string, variant: string | null) => `${brand ?? ""}${SEP}${name}${SEP}${variant ?? ""}`;

/**
 * Retire every seed-managed row the CSV no longer names, pointing it at its successor.
 *
 * The prune used to DELETE these, and list rows and My Gear rows hold catalog ids. A
 * rename the seed could map one-for-one kept its id (seedRenames.ts), but a fold could
 * not: "single bar" and "per bar" became one Clif bar, both old rows were deleted, and
 * every list that had picked either kept the old name forever, linked to nothing. My
 * Gear keys gear on that name, so the next pick of the new bar was a second row.
 *
 * Now the orphan stays, `merged` into the live row matchSuccessor finds for it
 * (shared/catalogLinks.ts), or `removed` when nothing is certain. Readers follow the
 * pointer (hydrateCatalogNames, the vault capture), search and pickers never see a
 * retired row, and a row the research names again is revived by the upsert. Run every
 * seed, so a pointer whose target later retires is re-aimed at the live row, and
 * idempotent: an unchanged answer writes nothing. Community rows are never touched.
 */
export async function retireOrphans(
  db: Db,
  rows: readonly CatalogCsvRow[],
): Promise<{ merged: number; removed: number }> {
  const wanted = new Set(rows.map((r) => identity(r.brand, r.name, r.variant)));
  const held = await db
    .select({
      id: catalogItems.id,
      brand: catalogItems.brand,
      name: catalogItems.name,
      variant: catalogItems.variant,
      weightMg: catalogItems.weightMg,
      verified: catalogItems.verified,
      status: catalogItems.status,
      mergedIntoId: catalogItems.mergedIntoId,
    })
    .from(catalogItems);
  const named = (r: (typeof held)[number]) => wanted.has(identity(r.brand, r.name, r.variant));
  const live = held
    .filter((r) => named(r) && r.status === "active")
    .map((r) => ({ ...r, weightMg: Number(r.weightMg) }));

  let merged = 0;
  let removed = 0;
  for (const r of held) {
    if (!r.verified || named(r)) continue;
    const next = matchSuccessor({ ...r, weightMg: Number(r.weightMg) }, live);
    const status = next ? "merged" : "removed";
    const mergedIntoId = next?.row.id ?? null;
    if (status === "merged") merged++;
    else removed++;
    if (r.status === status && (r.mergedIntoId ?? null) === mergedIntoId) continue;
    await db
      .update(catalogItems)
      .set({ status, mergedIntoId, updatedAt: new Date() })
      .where(eq(catalogItems.id, r.id));
  }
  return { merged, removed };
}
