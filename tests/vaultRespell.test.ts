// A catalog pick is captured into My Gear under the catalog's CURRENT spelling, whatever
// the list row still says (server/utils/vaultRepo respellCatalogPicks).
//
// The bug this pins, from Ryan's own vault (2026-10-31): the catalog renamed "Men's M"
// to "Men's Medium" and the seed moved his My Gear row with it, but every list kept the
// old text, and the sign-in backfill captures from what lists store. Each sign-in then
// minted "Alpha 60 Hoodie · Men's M" beside "Men's Medium", one per tidied product, and
// re-fed them every time after. Where the catalog had deleted the old row outright, the
// link went with it.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { CATALOG_DDL } from "../server/utils/catalog";
import { backfillVaultFromClaims, claimLists } from "../server/utils/claimRepo";
import { LISTS_DDL } from "../server/utils/db";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { captureVaultItems, listVaultItems } from "../server/utils/vaultRepo";
import { captureFromList } from "../shared/vault";
import type { Item } from "../shared/types";
import { createTestDb, makeList, type TestDb } from "./helpers/db";
import { item } from "./helpers/list";

const CURLY = "’";

async function setup() {
  const db = await createTestDb(LISTS_DDL, CATALOG_DDL, ACCOUNT_DDL, VAULT_DDL);
  const [vault] = await db.insert(schema.vaults).values({ userId: null }).returning({ id: schema.vaults.id });
  const [hoodie] = await db
    .insert(schema.catalogItems)
    .values({ brand: "Senchi Designs", name: "Alpha 60 Hoodie", variant: "Men's Medium", weightMg: 107_728, weightSource: "manufacturer", verified: true })
    .returning();
  return { db, vaultId: vault!.id, hoodie: hoodie! };
}

const picked = (over: Partial<Item>): Item =>
  item({ id: "h", brand: "Senchi Designs", name: "Alpha 60 Hoodie", unitWeightMg: 107_728, classification: "base", ...over });

const rowsOf = async (db: TestDb, vaultId: number) =>
  (await listVaultItems(db, vaultId)).map((r) => ({ variant: r.variant ?? null, catalogItemId: r.catalogItemId ?? null, timesSeen: r.timesSeen }));

describe("capturing a catalog pick", () => {
  it("lands a list saved before a tidy on the row the vault already holds", async () => {
    const { db, vaultId, hoodie } = await setup();
    await captureVaultItems(db, vaultId, captureFromList([picked({ variant: `Men${CURLY}s Medium`, catalogItemId: hoodie.id })]));
    await captureVaultItems(db, vaultId, captureFromList([picked({ variant: "Men's M", catalogItemId: hoodie.id })]));
    expect(await rowsOf(db, vaultId)).toEqual([{ variant: `Men${CURLY}s Medium`, catalogItemId: hoodie.id, timesSeen: 2 }]);
  });

  it("keeps a renamed row as its own gear, under its own text", async () => {
    const { db, vaultId, hoodie } = await setup();
    await captureVaultItems(db, vaultId, captureFromList([picked({ variant: "Men's Medium", catalogItemId: hoodie.id })]));
    await captureVaultItems(db, vaultId, captureFromList([picked({ variant: "Men's L", catalogItemId: hoodie.id, nameOverridden: true })]));
    expect((await rowsOf(db, vaultId)).map((r) => r.variant).sort()).toEqual([`Men${CURLY}s L`, `Men${CURLY}s Medium`]);
  });

  it("hands a retired row's link and spelling on to its successor", async () => {
    const { db, vaultId } = await setup();
    const [bar] = await db
      .insert(schema.catalogItems)
      .values({ brand: "Clif", name: "Builders Protein Bar (Chocolate Peanut Butter)", weightMg: 68_000, weightSource: "manufacturer", verified: true })
      .returning();
    const [single] = await db
      .insert(schema.catalogItems)
      .values({ brand: "Clif", name: "Builders Protein Bar (Chocolate Peanut Butter)", variant: "single bar", weightMg: 68_000, weightSource: "manufacturer", verified: true, status: "merged", mergedIntoId: bar!.id })
      .returning();
    const old = item({ id: "b", brand: "Clif", name: "Builders Protein Bar (Chocolate Peanut Butter)", variant: "single bar", unitWeightMg: 68_000, catalogItemId: single!.id, classification: "consumable" });
    await captureVaultItems(db, vaultId, captureFromList([old]));
    expect(await rowsOf(db, vaultId)).toEqual([{ variant: null, catalogItemId: bar!.id, timesSeen: 1 }]);
  });

  it("leaves an import's text alone: a file says nothing about what was renamed", async () => {
    const { db, vaultId, hoodie } = await setup();
    await captureVaultItems(db, vaultId, [{ normKey: "", brand: "Senchi Designs", name: "Alpha 60 Hoodie", variant: "Men's M", weightMg: 107_728, catalogItemId: hoodie.id }]);
    expect((await rowsOf(db, vaultId))[0]!.variant).toBe(`Men${CURLY}s M`);
  });

  it("stops the sign-in backfill re-minting a twin from what a list stores", async () => {
    const { db, hoodie } = await setup();
    const [user] = await db.insert(schema.users).values({ email: "ryan@example.com" }).returning();
    const list = await makeList(db, "Timberline", {
      data: { folders: [], items: [picked({ variant: "Men's M", catalogItemId: hoodie.id })] },
    });
    await claimLists(db, user!.id, [list.editToken]);
    await backfillVaultFromClaims(db, user!.id);
    await backfillVaultFromClaims(db, user!.id);
    const [vault] = await db.select().from(schema.vaults).where(eq(schema.vaults.userId, user!.id));
    expect(await rowsOf(db, vault!.id)).toEqual([{ variant: `Men${CURLY}s Medium`, catalogItemId: hoodie.id, timesSeen: 2 }]);
  });
});
