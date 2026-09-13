// Sizes as words (2026-09-12), applied to a database that predates the rule. Lives
// beside the seeder rather than in it so a test can run it on PGlite; seed-catalog.ts
// calls it before its upsert.
import { eq, isNotNull } from "drizzle-orm";
import { catalogItems, vaultItems } from "../server/db/schema";
import { sizeLettersToWords } from "../shared/catalogQuality";
import { vaultNormKey } from "../shared/vault";
import type { useDb } from "../server/utils/db";

type Db = Awaited<ReturnType<typeof useDb>>;

/**
 * Sizes as words (2026-09-12). A row that exists under the letter form ("M", "Men's M")
 * takes the word form IN PLACE, keeping its id, before the upsert below looks for it:
 * brand + name + variant is a row's identity, so without this the upsert would insert
 * "Medium" as a new row and the prune would drop "M", and every list row linked to the
 * old id would lose its live name and its "suggest a fix" path. My Gear's rows carry the
 * same text and are keyed on it (vaultNormKey), so they move with it, or a person's
 * "Revelation · M" would stop matching the "Revelation · Medium" they pick next.
 * Idempotent: a row already in words is left alone; a row whose word form already
 * exists (both spellings somehow present) is left for the prune.
 */
export async function sizesToWords(db: Db): Promise<{ catalog: number; vault: number }> {
  let catalog = 0;
  const rows = await db
    .select({ id: catalogItems.id, variant: catalogItems.variant })
    .from(catalogItems)
    .where(isNotNull(catalogItems.variant));
  for (const r of rows) {
    const next = sizeLettersToWords(r.variant!);
    if (next === r.variant) continue;
    try {
      await db.update(catalogItems).set({ variant: next }).where(eq(catalogItems.id, r.id));
      catalog++;
    } catch {
      /* the word form already exists as its own row: the prune below settles it */
    }
  }
  let vault = 0;
  try {
    const mine = await db
      .select({ id: vaultItems.id, brand: vaultItems.brand, name: vaultItems.name, variant: vaultItems.variant })
      .from(vaultItems)
      .where(isNotNull(vaultItems.variant));
    for (const r of mine) {
      const next = sizeLettersToWords(r.variant!);
      if (next === r.variant) continue;
      try {
        await db.update(vaultItems).set({ variant: next, normKey: vaultNormKey(r.brand, r.name, next) }).where(eq(vaultItems.id, r.id));
        vault++;
      } catch {
        /* the person already holds the word form: two rows for one thing, theirs to merge */
      }
    }
  } catch {
    /* no vault table on this database (a catalog-only seed target) */
  }
  return { catalog, vault };
}



