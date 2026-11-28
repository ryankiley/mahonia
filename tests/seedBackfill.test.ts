// The first reseed of a catalog that predates seed_weight_mg and seed_source_url
// (scripts/seedBackfill.ts, then the upsert): every kind of row production holds, built
// with the app's own writers, the pair blanked as it is on a table the columns were just
// added to, and the run's answer for each. Run on PGlite against the real tables.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { CATALOG_DDL, proposeCorrection, recentChanges } from "../server/utils/catalog";
import { undoCatalogEdit, verifyCatalogItem } from "../server/utils/catalogVerify";
import type { CatalogCsvRow } from "../scripts/catalogCsv";
import { backfillSeedColumns } from "../scripts/seedBackfill";
import { upsertSeedRows } from "../scripts/seedUpsert";
import { seedCatalogRow } from "./helpers/catalog";
import { createTestDb, type TestDb } from "./helpers/db";

const page = (name: string) => `https://zpacks.com/products/${name.toLowerCase().replace(/\W+/g, "-")}`;
const csv = (name: string, over: Partial<CatalogCsvRow> = {}): CatalogCsvRow => ({
  brand: "Zpacks",
  name,
  commonName: "Tent",
  variant: null,
  attributes: {},
  attributesUnpublished: [],
  categoryHint: "shelter",
  weightMg: 500_000,
  kcal: null,
  weightSource: "manufacturer",
  sourceUrl: page(name),
  searchTerms: "tent shelter",
  ...over,
});
const ADMIN = 7;

describe("the first reseed after the seed columns exist", () => {
  let db: TestDb;
  const idOf = async (name: string) => (await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.name, name)))[0]!.id;
  /** A visitor's cited fix, which a research row takes at once. */
  const correct = async (name: string, newWeightMg: number) => {
    expect((await proposeCorrection(db, { catalogItemId: await idOf(name), newWeightMg, sourceUrl: `${page(name)}?spec` })).status).toBe("applied");
  };
  /** An admin's verification of a row from the maker's page. */
  const verify = async (name: string, grams: number) => {
    const done = await verifyCatalogItem(db, ADMIN, { catalog_id: await idOf(name), weight_g: grams, source_url: `${page(name)}-2026`, quote: `Weight ${grams} g` });
    expect(done).toMatchObject({ row: { verifiedBy: ADMIN } });
  };
  /** A product the admin added in the app. */
  const add = async (brand: string, name: string, grams: number) => {
    const done = await verifyCatalogItem(db, ADMIN, { brand, name, gear_type: "Tent", weight_g: grams, source_url: page(name), quote: `Weight ${grams} g` });
    expect(done).toMatchObject({ created: true });
  };
  /** Each row as [weight, link, verifier, the research's weight, the research's link, status]. */
  const state = async () =>
    Object.fromEntries(
      (await db.select().from(schema.catalogItems).orderBy(schema.catalogItems.id)).map((r) => [
        r.name,
        [Number(r.weightMg), r.sourceUrl, r.verifiedBy, r.seedWeightMg == null ? null : Number(r.seedWeightMg), r.seedSourceUrl, r.status],
      ]),
    );

  beforeEach(async () => {
    db = await createTestDb(CATALOG_DDL);
  });

  it("writes down what the research said for each kind of row, and the upsert then does what each is owed", async () => {
    // ---- the catalog as the reseeds before this one left it ----
    const seeded = ["Plain", "Research moved", "Corrected", "Corrected then research moved", "Adopted then corrected", "Correction undone", "Verified", "Corrected then verified", "Graduated", "Retired"];
    await upsertSeedRows(db, seeded.map((name) => csv(name)));
    await correct("Corrected", 505_000);
    await correct("Corrected then research moved", 505_000);
    await correct("Adopted then corrected", 505_000);
    await upsertSeedRows(db, seeded.map((name) => csv(name, name === "Adopted then corrected" ? { weightMg: 505_000 } : {})));
    await correct("Adopted then corrected", 508_000);
    await correct("Correction undone", 505_000);
    const [undone] = await recentChanges(db, 1);
    expect(await undoCatalogEdit(db, undone!.id)).toMatchObject({ rejected: false });
    await verify("Verified", 495);
    await correct("Corrected then verified", 505_000);
    // (each at its own weight: the house style reads two like-named rows of one weight as one product)
    await verify("Corrected then verified", 494);
    await verify("Graduated", 493);
    await db.update(schema.catalogItems).set({ status: "removed" }).where(eq(schema.catalogItems.name, "Retired"));
    await add("Durston", "X-Mid 2", 1022);
    await add("Tarptent", "Notch Li", 560);
    await seedCatalogRow(db, { brand: "Zpacks", name: "Community" });
    await seedCatalogRow(db, { brand: "Zpacks", name: "Community claimed", weightMg: 480_000 });
    // the columns as a table that has only just been given them holds them
    await db.execute(sql`update catalog_items set seed_weight_mg = null, seed_source_url = null`);

    // ---- the research this reseed carries ----
    const research = [
      csv("Plain"),
      csv("Research moved", { weightMg: 510_000 }),
      csv("Corrected"),
      csv("Corrected then research moved", { weightMg: 520_000 }),
      csv("Adopted then corrected", { weightMg: 505_000 }),
      csv("Correction undone"),
      csv("Verified"),
      csv("Corrected then verified"),
      // what catalog:graduate wrote back: the research agrees with the app
      csv("Graduated", { weightMg: 493_000, sourceUrl: `${page("Graduated")}-2026` }),
      csv("Notch Li", { brand: "Tarptent", weightMg: 560_000 }),
      csv("Community claimed"),
      csv("New"),
    ];
    const id = Object.fromEntries(await Promise.all([...seeded, "X-Mid 2", "Notch Li", "Community", "Community claimed"].map(async (name) => [name, await idOf(name)] as const)));

    expect(await backfillSeedColumns(db, research)).toEqual({
      inApp: [id.Verified, id["Corrected then verified"], id.Graduated],
      // verified over a visitor's 505 g, which the research never said
      inAppDiffers: [id["Corrected then verified"]],
      corrected: [id.Corrected, id["Adopted then corrected"]],
      seedRows: 5,
    });
    const out = await upsertSeedRows(db, research);
    expect({ ...out, kept: out.kept.map((k) => [k.name, k.researchMg, k.liveMg]) }).toEqual({
      inserted: 1,
      updated: 6,
      unchanged: 3,
      held: 2,
      kept: [["Corrected", 500_000, 505_000], ["Adopted then corrected", 505_000, 508_000]],
    });

    const fix = (name: string) => `${page(name)}?spec`;
    const admin = (name: string) => `${page(name)}-2026`;
    expect(await state()).toEqual({
      Plain: [500_000, page("Plain"), null, 500_000, page("Plain"), "active"],
      "Research moved": [510_000, page("Research moved"), null, 510_000, page("Research moved"), "active"],
      // kept, with its citation; the pair is the research's
      Corrected: [505_000, fix("Corrected"), null, 500_000, page("Corrected"), "active"],
      "Corrected then research moved": [520_000, page("Corrected then research moved"), null, 520_000, page("Corrected then research moved"), "active"],
      "Adopted then corrected": [508_000, fix("Adopted then corrected"), null, 505_000, page("Adopted then corrected"), "active"],
      "Correction undone": [500_000, page("Correction undone"), null, 500_000, page("Correction undone"), "active"],
      // held as the admin left them; the pair is what the research says, not what they replaced
      Verified: [495_000, admin("Verified"), ADMIN, 500_000, page("Verified"), "active"],
      "Corrected then verified": [494_000, admin("Corrected then verified"), ADMIN, 500_000, page("Corrected then verified"), "active"],
      // the research agrees: the seed's again
      Graduated: [493_000, admin("Graduated"), null, 493_000, admin("Graduated"), "active"],
      Retired: [500_000, page("Retired"), null, 500_000, page("Retired"), "removed"],
      // added in the app and not in the research: the seed has never written it
      "X-Mid 2": [1_022_000, page("X-Mid 2"), ADMIN, null, null, "active"],
      "Notch Li": [560_000, page("Notch Li"), null, 560_000, page("Notch Li"), "active"],
      Community: [12_000, null, null, null, null, "active"],
      "Community claimed": [500_000, page("Community claimed"), null, 500_000, page("Community claimed"), "active"],
      New: [500_000, page("New"), null, 500_000, page("New"), "active"],
    });

    // ---- the next reseed: nothing left to fill in, nothing to write ----
    expect(await backfillSeedColumns(db, research)).toBeNull();
    expect(await upsertSeedRows(db, research)).toMatchObject({ inserted: 0, updated: 0, unchanged: 10, held: 2 });
  });

  it("takes what a verification replaced when the research no longer names the row", async () => {
    await upsertSeedRows(db, [csv("Dropped")]);
    await verify("Dropped", 495);
    await db.execute(sql`update catalog_items set seed_weight_mg = null, seed_source_url = null`);
    // a seed row still without the pair is what starts the backfill
    await upsertSeedRows(db, [csv("Plain")]);
    await db.execute(sql`update catalog_items set seed_weight_mg = null, seed_source_url = null`);
    expect(await backfillSeedColumns(db, [csv("Plain")])).toEqual({ inApp: [await idOf("Dropped")], inAppDiffers: [], corrected: [], seedRows: 1 });
    expect((await state()).Dropped).toEqual([495_000, `${page("Dropped")}-2026`, ADMIN, 500_000, page("Dropped"), "active"]);
  });

  it("finishes a run that stopped part way, and leaves a filled row as it is", async () => {
    await upsertSeedRows(db, [csv("Plain"), csv("Corrected")]);
    await correct("Corrected", 505_000);
    await db.execute(sql`update catalog_items set seed_weight_mg = null, seed_source_url = null`);
    // the corrected row was written, the plain rows weren't: the state a stopped run leaves
    await db.update(schema.catalogItems).set({ seedWeightMg: 500_000, seedSourceUrl: page("Corrected") }).where(eq(schema.catalogItems.name, "Corrected"));
    expect(await backfillSeedColumns(db, [csv("Plain"), csv("Corrected")])).toEqual({ inApp: [], inAppDiffers: [], corrected: [], seedRows: 1 });
    expect((await upsertSeedRows(db, [csv("Plain"), csv("Corrected")])).kept.map((k) => k.liveMg)).toEqual([505_000]);
  });

  it("does nothing on a catalog with no seed rows to fill: a new database, or one already done", async () => {
    await seedCatalogRow(db, { name: "Community" });
    expect(await backfillSeedColumns(db, [csv("Plain")])).toBeNull();
    await upsertSeedRows(db, [csv("Plain")]);
    expect(await backfillSeedColumns(db, [csv("Plain")])).toBeNull();
  });
});
