import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import {
  listVaultFolders,
  listVaultItems,
  searchVaultItems,
} from "../server/utils/vaultRepo";
import { vaultNormKey } from "../shared/vault";
import { createTestDb } from "./helpers/db";

const CURLY = String.fromCharCode(0x2019);

/** A vault holding rows captured BEFORE the tidy shipped — straight apostrophes,
 *  doubled spaces, untrimmed ends, exactly as the old capture wrote them. */
async function legacyVault() {
  const db = await createTestDb(VAULT_DDL);
  const [vault] = await db
    .insert(schema.vaults)
    .values({ tokenHash: "h", userId: null })
    .returning({ id: schema.vaults.id });
  const vaultId = vault!.id;

  const [folder] = await db
    .insert(schema.vaultFolders)
    .values({ vaultId, name: "Men's  layers", sortOrder: 0 })
    .returning({ id: schema.vaultFolders.id });

  await db.insert(schema.vaultItems).values([
    {
      vaultId,
      // the key the OLD code computed, from the OLD straight-apostrophe text
      normKey: vaultNormKey("Arc'teryx", "Cerium LT Hoody", "Men's"),
      brand: "Arc'teryx",
      name: "  Ryan's  tent ",
      variant: "Men's  Regular",
      commonName: " down jacket ",
      weightMg: 283000,
      folderId: folder!.id,
    },
    {
      vaultId,
      normKey: vaultNormKey(null, "Guyline 6'", null),
      brand: null,
      name: "Guyline 6'",
      weightMg: 20000,
    },
  ]);
  return { db, vaultId };
}

describe("a vault captured before the tidy existed", () => {
  it("reads back tidied on the /vault page", async () => {
    const { db, vaultId } = await legacyVault();
    const rows = await listVaultItems(db as never, vaultId);
    const tent = rows.find((r) => r.name.includes("tent"))!;
    expect(tent.name).toBe(`Ryan${CURLY}s tent`);
    expect(tent.brand).toBe(`Arc${CURLY}teryx`);
    expect(tent.variant).toBe(`Men${CURLY}s Regular`);
    expect(tent.commonName).toBe("down jacket");
  });

  it("reads back tidied through the autocomplete too", async () => {
    const { db, vaultId } = await legacyVault();
    const hits = await searchVaultItems(db as never, vaultId, "tent");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.brand).toBe(`Arc${CURLY}teryx`);
  });

  it("tidies vault folder names as well", async () => {
    const { db, vaultId } = await legacyVault();
    const folders = await listVaultFolders(db as never, vaultId);
    expect(folders[0]!.name).toBe(`Men${CURLY}s layers`);
  });

  it("leaves a foot mark alone here too", async () => {
    const { db, vaultId } = await legacyVault();
    const rows = await listVaultItems(db as never, vaultId);
    expect(rows.some((r) => r.name === "Guyline 6'")).toBe(true);
  });

  // The property that makes tidying a vault row safe at all: identity is normKey,
  // which folds through foldForSearch (non-alphanumerics stripped). If tidying could
  // change it, an old row and a new capture of the same gear would become two rows.
  it("does NOT change a row's identity — the tidy is display-only", async () => {
    const { db, vaultId } = await legacyVault();
    const rows = await listVaultItems(db as never, vaultId);
    const tent = rows.find((r) => r.name.includes("tent"))!;
    // the key stored under the old spelling still equals the key the new spelling makes
    expect(vaultNormKey("Arc'teryx", "Cerium LT Hoody", "Men's")).toBe(
      vaultNormKey(`Arc${CURLY}teryx`, "Cerium LT Hoody", `Men${CURLY}s`),
    );
    expect(tent.normKey).toBe(vaultNormKey("Arc'teryx", "Cerium LT Hoody", "Men's"));
  });
});
