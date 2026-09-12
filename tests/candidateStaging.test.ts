// The save path's half of the community intake: WHICH edits stage a typed row, and
// what the staged row carries. corroborateCatalog's half (promotion) is in
// candidates.test.ts; this is the feed. A row is named first and weighed a moment
// later, in a later batch, so staging on the name alone recorded most typed rows
// weightless, and a candidate needs two weights to become anything.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { CATALOG_DDL } from "../server/utils/catalog";
import { CANDIDATES_DDL } from "../server/utils/candidates";
import { LISTS_DDL } from "../server/utils/db";
import { applyOpsByEditHash } from "../server/utils/listRepo";
import { sha256Hex } from "../server/utils/tokens";
import { createTestDb, makeList, type TestDb } from "./helpers/db";

type Staged = { raw_name: string; raw_brand: string | null; raw_variant: string | null; raw_common_name: string | null; weight_mg: number | null };
const staged = async (db: TestDb): Promise<Staged[]> =>
  ((await db.execute(sql`select raw_name, raw_brand, raw_variant, raw_common_name, weight_mg::int from catalog_candidates order by id`)) as { rows: Staged[] }).rows;

describe("community intake — what a list save stages", () => {
  let db: TestDb;
  let hash: string;
  beforeEach(async () => {
    db = await createTestDb(LISTS_DDL, CATALOG_DDL, CANDIDATES_DDL);
    const list = await makeList(db, "Sierra", {
      data: { folders: [{ id: "f1", name: "Shelter", colorKey: "shelter", defaultClassification: "base", sortOrder: 0 }], items: [] },
      itemCount: 0,
      version: 1,
    });
    hash = sha256Hex(list.editToken);
  });

  const typedRow = { id: "i1", folderId: "f1", name: "Frobozz Megapack 9000", unitWeightMg: 0, qty: 1, classification: null, sortOrder: 0 };

  it("re-stages a typed row when its weight is typed in a later batch", async () => {
    await applyOpsByEditHash(hash, [{ t: "addItem", item: typedRow }], db as never);
    expect(await staged(db)).toEqual([{ raw_name: "Frobozz Megapack 9000", raw_brand: null, raw_variant: null, raw_common_name: null, weight_mg: null }]);

    await applyOpsByEditHash(hash, [{ t: "updateItem", id: "i1", patch: { unitWeightMg: 810_000 } }], db as never);
    // the same candidate (one per name + list), now with the weight
    expect(await staged(db)).toEqual([{ raw_name: "Frobozz Megapack 9000", raw_brand: null, raw_variant: null, raw_common_name: null, weight_mg: 810_000 }]);

    // and the gear type, typed later still
    await applyOpsByEditHash(hash, [{ t: "updateItem", id: "i1", patch: { commonName: "Pack" } }], db as never);
    expect((await staged(db))[0]!.raw_common_name).toBe("Pack");
  });

  it("stages the typed size or version, as part of the candidate's identity", async () => {
    await applyOpsByEditHash(hash, [{ t: "addItem", item: typedRow }], db as never);
    await applyOpsByEditHash(hash, [{ t: "updateItem", id: "i1", patch: { variant: "Long" } }], db as never);
    // a new identity: "Frobozz Megapack 9000 Long" is not "Frobozz Megapack 9000"
    expect(await staged(db)).toEqual([
      { raw_name: "Frobozz Megapack 9000", raw_brand: null, raw_variant: null, raw_common_name: null, weight_mg: null },
      { raw_name: "Frobozz Megapack 9000", raw_brand: null, raw_variant: "Long", raw_common_name: null, weight_mg: null },
    ]);
  });

  it("does not stage on an edit to something the candidate does not record", async () => {
    await applyOpsByEditHash(hash, [{ t: "addItem", item: typedRow }], db as never);
    const before = await staged(db);
    await applyOpsByEditHash(hash, [{ t: "updateItem", id: "i1", patch: { qty: 3, description: "the blue one" } }], db as never);
    expect(await staged(db)).toEqual(before);
  });

  it("never stages a catalog-linked row", async () => {
    await applyOpsByEditHash(hash, [{ t: "addItem", item: { ...typedRow, catalogItemId: 1, unitWeightMg: 500_000 } }], db as never);
    await applyOpsByEditHash(hash, [{ t: "updateItem", id: "i1", patch: { unitWeightMg: 510_000 } }], db as never);
    expect(await staged(db)).toEqual([]);
  });
});
