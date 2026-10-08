// The reseed's in-place refold (scripts/seedIdentities): a My Gear row keyed under the
// old a–z-only fold takes its current key and KEEPS ITS ID, so the next capture of the
// same gear finds it instead of adding a twin. Run on PGlite against the real tables.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { CATALOG_DDL } from "../server/utils/catalog";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { refoldVaultIdentities } from "../scripts/seedIdentities";
import { vaultNormKey } from "../shared/vault";
import { createTestDb, type TestDb } from "./helpers/db";

describe("refoldVaultIdentities", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb(CATALOG_DDL, VAULT_DDL);
    await db.execute(sql`insert into vaults (id, user_id) values (1, 1)`).catch(() => {});
  });

  it("re-keys a row the old fold mangled, id kept, and leaves the rest", async () => {
    const [norrona] = await db
      .insert(schema.vaultItems)
      .values({ vaultId: 1, normKey: "norr na falketind", brand: "Norrøna", name: "Falketind", weightMg: 300_000 } as never)
      .returning();
    const [poles] = await db
      .insert(schema.vaultItems)
      .values({ vaultId: 1, normKey: "trekology", brand: "Trekology", name: "登山杖（裸杖）", weightMg: 400_000 } as never)
      .returning();
    const [duplex] = await db
      .insert(schema.vaultItems)
      .values({ vaultId: 1, normKey: vaultNormKey("Zpacks", "Duplex", null), brand: "Zpacks", name: "Duplex", weightMg: 539_000 } as never)
      .returning();

    expect(await refoldVaultIdentities(db as never)).toBe(2);
    const after = (await db.select().from(schema.vaultItems)) as { id: number; normKey: string }[];
    expect(after.find((r) => r.id === norrona!.id)!.normKey).toBe(vaultNormKey("Norrøna", "Falketind", null));
    expect(after.find((r) => r.id === poles!.id)!.normKey).toBe(vaultNormKey("Trekology", "登山杖（裸杖）", null));
    expect(after.find((r) => r.id === duplex!.id)!.normKey).toBe(vaultNormKey("Zpacks", "Duplex", null));

    // idempotent
    expect(await refoldVaultIdentities(db as never)).toBe(0);
  });

  it("leaves a row alone when the person already holds one under its new key", async () => {
    await db.insert(schema.vaultItems).values({ vaultId: 1, normKey: "norr na falketind", brand: "Norrøna", name: "Falketind", weightMg: 300_000 } as never);
    await db.insert(schema.vaultItems).values({ vaultId: 1, normKey: vaultNormKey("Norrona", "Falketind", null), brand: "Norrona", name: "Falketind", weightMg: 310_000 } as never);
    expect(await refoldVaultIdentities(db as never)).toBe(0);
    const rows = await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.vaultId, 1));
    expect(rows).toHaveLength(2);
  });
});
