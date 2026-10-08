// Identities refolded (2026-10-08), applied to a database that predates the fold
// keeping every script's letters. Lives beside the seeder rather than in it so a test
// can run it on PGlite; seed-catalog.ts calls it before its upsert.
import { eq } from "drizzle-orm";
import { vaultItems } from "../server/db/schema";
import { vaultNormKey } from "../shared/vault";
import type { useDb } from "../server/utils/db";

type Db = Awaited<ReturnType<typeof useDb>>;

/**
 * Refold every My Gear identity (2026-10-08). A row's norm_key is its brand + name +
 * variant through foldForSearch, and that fold used to drop any letter outside a–z
 * once the diacritics were off: "Norrøna" keyed as "norr na", a name in Chinese as
 * "" and so was never kept. The fold now keeps letters in every script and spells the
 * undecomposable Latin ones out (ø→o), so a stored key can differ from the one the
 * next capture of the same gear derives — and the capture, finding no row under its
 * key, would insert a second. Rewriting the stored key in place closes that gap: the
 * row keeps its id, its weight, its notes and its link to the catalog.
 * Idempotent: a row already under its current key is left alone; a row whose new key
 * the person somehow already holds is left for them to merge, as sizesToWords does.
 */
export async function refoldVaultIdentities(db: Db): Promise<number> {
  let moved = 0;
  try {
    const rows = await db
      .select({ id: vaultItems.id, normKey: vaultItems.normKey, brand: vaultItems.brand, name: vaultItems.name, variant: vaultItems.variant })
      .from(vaultItems);
    for (const r of rows) {
      const next = vaultNormKey(r.brand, r.name, r.variant);
      if (!next || next === r.normKey) continue;
      try {
        await db.update(vaultItems).set({ normKey: next }).where(eq(vaultItems.id, r.id));
        moved++;
      } catch {
        /* the person already holds a row under the new key: two rows for one thing, theirs to merge */
      }
    }
  } catch {
    /* no vault table on this database (a catalog-only seed target) */
  }
  return moved;
}
