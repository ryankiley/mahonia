// The read-only link to a vault's gear: turning it on and off, and the public read.
// What the link shows is decided in shared/vaultShare.ts (sharedGear); this module only
// finds the vault and its owner's name.
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { vaults } from "../db/schema";
import { isUniqueViolation, type Db } from "./db";
import { chosenName } from "./listRepo";
import { listVaultItems } from "./vaultRepo";
import { randomShareCode } from "./tokens";
import { normalizeShareCode } from "../../shared/links";
import { sharedGear, type SharedGear } from "../../shared/vaultShare";

/** The vault's link code, or null while it is off. */
export async function vaultShareCode(
  db: Db,
  vaultId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ code: vaults.shareCode })
    .from(vaults)
    .where(eq(vaults.id, vaultId));
  return row?.code ?? null;
}

/**
 * Turn the link on or off. On keeps a link that is already on (asking twice is not a
 * new link) and mints one otherwise; off clears it, so the old link is dead for good and
 * turning it on again hands out a different one. Answers the code now in force.
 */
export async function setVaultShare(
  db: Db,
  vaultId: number,
  on: boolean,
): Promise<string | null> {
  if (!on) {
    await db
      .update(vaults)
      .set({ shareCode: null })
      .where(eq(vaults.id, vaultId));
    return null;
  }
  const current = await vaultShareCode(db, vaultId);
  if (current) return current;
  // ~60 bits, so a clash is all but impossible; the unique index makes one an error
  // rather than two vaults behind one link, and a retry draws again
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomShareCode();
    try {
      await db
        .update(vaults)
        .set({ shareCode: code })
        .where(and(eq(vaults.id, vaultId), isNull(vaults.shareCode)));
      return (await vaultShareCode(db, vaultId)) ?? code;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new Error("could not mint a gear share code");
}

/** What /g/{code} shows, or null for a code that names no live, owned vault (off, never
 *  on, or mistyped: all one answer, so the reply can't be used to probe for codes). */
export async function sharedGearByCode(
  db: Db,
  rawCode: string,
): Promise<SharedGear | null> {
  const code = normalizeShareCode(rawCode);
  if (!code) return null;
  const [vault] = await db
    .select({ id: vaults.id, userId: vaults.userId })
    .from(vaults)
    .where(and(eq(vaults.shareCode, code), isNotNull(vaults.userId)));
  if (!vault) return null;
  // the name the owner chose, on the rule a list's byline follows (listRepo's chosenNames)
  return sharedGear(await listVaultItems(db, vault.id), await chosenName(db, vault.userId!));
}
