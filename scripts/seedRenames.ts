// A catalog row whose variant was tidied keeps its id (2026-09-12). Lives beside the
// seeder rather than in it so a test can run it on PGlite; seed-catalog.ts calls it
// before its upsert, after sizesToWords.
import { eq } from "drizzle-orm";
import { catalogItems, vaultItems } from "../server/db/schema";
import { vaultNormKey } from "../shared/vault";
import type { Db } from "../server/utils/db";
import type { CatalogCsvRow } from "./catalogCsv";
import { identity } from "./seedUpsert";

const SEP = "\u0000";
const product = (brand: string | null, name: string, weightMg: number, sourceUrl: string | null) =>
  `${brand ?? ""}${SEP}${name}${SEP}${weightMg}${SEP}${sourceUrl ?? ""}`;

/**
 * brand + name + variant is a row's identity, so a variant tidied in the research
 * ("Medium, JP 3" → "JP 3") reaches the upsert as a row it has never seen and the prune
 * as a row the CSV no longer wants: the product would be inserted under a new id and
 * deleted under the old, and every list row linked to the old id would lose its live
 * name and its "suggest a fix" path — the reason sizesToWords renames in place. So a
 * seed-managed row the CSV no longer names and a CSV row the database does not hold
 * yet, with the same brand, name, weight and source, ONE of each, are the same product
 * under a new variant: the row takes the new variant, id kept, and My Gear's rows under
 * the old text move with it (they are keyed on it, vaultNormKey). Two orphans or two
 * newcomers for one product are not a rename — a size split, a size dropped — and are
 * left to the upsert and the prune. Idempotent: a renamed row is neither orphan nor
 * newcomer the next time.
 */
export async function renameMovedVariants(db: Db, rows: readonly CatalogCsvRow[]): Promise<{ catalog: number; vault: number }> {
  const held = await db
    .select({ id: catalogItems.id, brand: catalogItems.brand, name: catalogItems.name, variant: catalogItems.variant, weightMg: catalogItems.weightMg, sourceUrl: catalogItems.sourceUrl, verified: catalogItems.verified })
    .from(catalogItems);
  const heldIdentities = new Set(held.map((r) => identity(r.brand, r.name, r.variant)));
  const wanted = new Set(rows.map((r) => identity(r.brand, r.name, r.variant)));

  const orphans = new Map<string, typeof held>();
  for (const r of held) {
    if (!r.verified || wanted.has(identity(r.brand, r.name, r.variant))) continue;
    const key = product(r.brand, r.name, Number(r.weightMg), r.sourceUrl);
    orphans.getOrInsertComputed(key, () => []).push(r);
  }
  const newcomers = new Map<string, CatalogCsvRow[]>();
  for (const r of rows) {
    if (heldIdentities.has(identity(r.brand, r.name, r.variant))) continue;
    const key = product(r.brand, r.name, r.weightMg, r.sourceUrl);
    newcomers.set(key, [...(newcomers.get(key) ?? []), r]);
  }

  let catalog = 0;
  let vault = 0;
  for (const [key, from] of orphans) {
    const to = newcomers.get(key);
    if (from.length !== 1 || to?.length !== 1) continue;
    const old = from[0]!;
    const next = to[0]!.variant;
    await db.update(catalogItems).set({ variant: next }).where(eq(catalogItems.id, old.id));
    catalog++;
    try {
      const mine = await db
        .select({ id: vaultItems.id })
        .from(vaultItems)
        .where(eq(vaultItems.normKey, vaultNormKey(old.brand, old.name, old.variant)));
      for (const r of mine) {
        try {
          await db.update(vaultItems).set({ variant: next, normKey: vaultNormKey(old.brand, old.name, next) }).where(eq(vaultItems.id, r.id));
          vault++;
        } catch {
          /* the person already holds the new form: two rows for one thing, theirs to merge */
        }
      }
    } catch {
      /* no vault table on this database (a catalog-only seed target) */
    }
  }
  return { catalog, vault };
}
