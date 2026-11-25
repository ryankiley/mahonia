// A catalog pick that reaches My Gear with no gear type of its own files under the
// catalog's.
//
// The case this pins: a row nested under a group hands its gear type up to the group
// (the group is "Tent"; the X-Mid 2 inside it is cleared, with commonNameOverridden, a
// recorded decision). A piece that first reached My Gear after that was captured with
// no kind, the upsert had nothing to fall back on, and it filed under "Other". The
// catalog is read at capture, on the server, so the answer is the same from any device
// and for the sign-in backfill.
import { describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { CATALOG_DDL } from "../server/utils/catalog";
import { LISTS_DDL } from "../server/utils/db";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { applyVaultItemOp, captureKit, captureVaultItems, listVaultItems } from "../server/utils/vaultRepo";
import { captureFromList } from "../shared/vault";
import { kitFromGroup } from "../shared/vaultKit";
import type { Item } from "../shared/types";
import { seedCatalogRow } from "./helpers/catalog";
import { createTestDb, type TestDb } from "./helpers/db";
import { item } from "./helpers/list";

async function setup() {
  const db = await createTestDb(LISTS_DDL, CATALOG_DDL, ACCOUNT_DDL, VAULT_DDL);
  const [vault] = await db.insert(schema.vaults).values({ userId: null }).returning({ id: schema.vaults.id });
  const tent = await seedCatalogRow(db, { brand: "Durston", name: "X-Mid 2", commonName: "Tent", weightMg: 998_000, weightSource: "manufacturer", verified: true });
  return { db, vaultId: vault!.id, tent };
}

// the list as the editor leaves it once the tent is wrapped in a group
const group = item({ id: "g", name: "Tent", commonName: "Tent" });
const nested = (catalogItemId: number | undefined, over: Partial<Item> = {}): Item =>
  item({ id: "t", parentId: "g", brand: "Durston", name: "X-Mid 2", unitWeightMg: 998_000, commonName: "", commonNameOverridden: true, catalogItemId, ...over });
const stakes = item({ id: "s", parentId: "g", name: "Stakes", unitWeightMg: 60_000 });

const kindsOf = async (db: TestDb, vaultId: number) =>
  Object.fromEntries((await listVaultItems(db, vaultId)).map((r) => [r.name, r.commonName ?? null]));

describe("the kind of a catalog pick captured with none of its own", () => {
  it("is the catalog's, for a piece first captured from inside a group", async () => {
    const { db, vaultId, tent } = await setup();
    await captureVaultItems(db, vaultId, captureFromList([group, nested(tent.id), stakes]));
    expect(await kindsOf(db, vaultId)).toEqual({ "X-Mid 2": "Tent", Stakes: null });
  });

  it("fills a row an earlier capture left without one", async () => {
    const { db, vaultId, tent } = await setup();
    // as the sign-in backfill or another device sends it: no link the first time
    await captureVaultItems(db, vaultId, captureFromList([group, nested(undefined)]));
    expect(await kindsOf(db, vaultId)).toEqual({ "X-Mid 2": null });
    await captureVaultItems(db, vaultId, captureFromList([group, nested(tent.id)]));
    expect(await kindsOf(db, vaultId)).toEqual({ "X-Mid 2": "Tent" });
  });

  it("never replaces a kind the piece already has", async () => {
    const { db, vaultId, tent } = await setup();
    await captureVaultItems(db, vaultId, captureFromList([nested(tent.id, { parentId: null, commonName: "Shelter" })]));
    await captureVaultItems(db, vaultId, captureFromList([group, nested(tent.id)]));
    expect(await kindsOf(db, vaultId)).toEqual({ "X-Mid 2": "Shelter" });
  });

  it("leaves a kind cleared by hand in My Gear cleared", async () => {
    const { db, vaultId, tent } = await setup();
    await captureVaultItems(db, vaultId, captureFromList([group, nested(tent.id)]));
    const [row] = await listVaultItems(db, vaultId);
    await applyVaultItemOp(db, vaultId, { t: "edit", id: row!.id, patch: { commonName: null } });
    await captureVaultItems(db, vaultId, captureFromList([group, nested(tent.id)]));
    expect(await kindsOf(db, vaultId)).toEqual({ "X-Mid 2": null });
  });

  it("leaves a piece with no catalog link and no kind as it is", async () => {
    const { db, vaultId } = await setup();
    await captureVaultItems(db, vaultId, captureFromList([group, nested(undefined)]));
    expect(await kindsOf(db, vaultId)).toEqual({ "X-Mid 2": null });
  });

  it("reaches the parts of a group saved as a kit", async () => {
    const { db, vaultId, tent } = await setup();
    const kit = kitFromGroup(group, [group, nested(tent.id), stakes])!;
    await captureKit(db, vaultId, kit.kit, kit.parts);
    expect((await kindsOf(db, vaultId))["X-Mid 2"]).toBe("Tent");
  });
});
