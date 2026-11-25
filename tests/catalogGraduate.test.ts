// catalog:graduate's pieces (scripts/graduate.ts): the rows an admin verified in the app
// come out as research rows the audit passes, a measured row with no citation URL stays
// behind, a graduated row replaces its own earlier copy in the file, and a research row
// corrected in the app goes back into its own row, the file written whole in the house layout.
// Run on PGlite.
import { describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { CATALOG_DDL } from "../server/utils/catalog";
import { specToMg } from "../scripts/catalogCsv";
import {
  asResearchRow,
  inAppVerified,
  mergeResearch,
  notInResearch,
  planGraduation,
  researchIdentity,
  researchWhenVerified,
  rewriteResearchRows,
} from "../scripts/graduate";
import { formatResearchFile, type ResearchRow } from "../scripts/research";
import { runResearchChecks } from "../scripts/researchChecks";
import { seedCatalogRow } from "./helpers/catalog";
import { createTestDb } from "./helpers/db";

describe("catalog:graduate", () => {
  it("writes in-app verified rows as research the audit passes, and keeps an uncited one back", async () => {
    const db = await createTestDb(CATALOG_DDL);
    await seedCatalogRow(db, { brand: "Durston", name: "X-Mid 2", weightMg: 1_022_000, weightSource: "manufacturer", sourceUrl: "https://durstongear.com/products/x-mid-2", sourceQuote: "Total Weight: 36 oz / 1022 g", verified: true, verifiedBy: 7, commonName: "Tent", categoryHint: "shelter" });
    await seedCatalogRow(db, { brand: "Toaks", name: "Titanium 750 Pot", weightMg: 103_000, weightSource: "measured", verified: true, verifiedBy: 7, commonName: "Pot", categoryHint: "cook" });
    await seedCatalogRow(db, { brand: "Zpacks", name: "Duplex", weightMg: 539_000, weightSource: "manufacturer", sourceUrl: "https://zpacks.com/duplex", verified: true });
    await seedCatalogRow(db, { brand: "Nemo", name: "Hornet", weightMg: 900_000, verified: true, verifiedBy: 7, sourceUrl: "https://nemoequipment.com/hornet", status: "removed" });

    const rows = await inAppVerified(db as never);
    expect(rows.map((r) => r.name).sort()).toEqual(["Titanium 750 Pot", "X-Mid 2"]);
    const research = rows.map(asResearchRow);
    const cited = research.filter((r) => r !== null);
    expect(cited).toEqual([
      { brand: "Durston", name: "X-Mid 2", variant: null, category_hint: "shelter", common_name: "Tent", weight_value: 1022, weight_unit: "g", weight_source: "manufacturer", source_url: "https://durstongear.com/products/x-mid-2", quote: "Total Weight: 36 oz / 1022 g" },
    ]);
    const errors = runResearchChecks([{ file: "verified-in-app.json", rows: cited }]).filter((f) => f.level === "error");
    expect(errors).toEqual([]);
  });

  it("holds a graduated row's quote to the tool's reading, ounces included", () => {
    // taken on its ounces (567 g = 1 lb 4 oz); the 500 g is another thing on the page
    const row = { brand: "Gossamer Gear", name: "The Two", variant: null, category_hint: "shelter", common_name: "Tent", weight_value: 567, weight_unit: "g" as const, weight_source: "manufacturer", source_url: "https://gossamergear.com/the-two", quote: "Packed weight 1 lb 4 oz; fits a 500 g canister" };
    const quoteErrors = (file: string, r: typeof row) => runResearchChecks([{ file, rows: [r] }]).filter((f) => f.code === "quote");
    expect(quoteErrors("verified-in-app.json", row)).toEqual([]);
    // an ounce figure that doesn't back the weight fails the graduated row too
    expect(quoteErrors("verified-in-app.json", { ...row, quote: "Packed weight 23 oz" })).toHaveLength(1);
    // the hand research keeps its metric read
    expect(quoteErrors("shelters.json", row)).toHaveLength(1);
  });

  it("replaces a row's earlier copy and keeps the rest", () => {
    const before = [{ brand: "Durston", name: "X-Mid 2", variant: null, weight_value: 1000 }, { brand: "Toaks", name: "Pot", variant: null, weight_value: 90 }];
    const merged = mergeResearch(before, [{ brand: "Durston", name: "X-Mid 2", variant: null, weight_value: 1022 }]);
    expect(merged.map((r) => [r.name, r.weight_value])).toEqual([["X-Mid 2", 1022], ["Pot", 90]]);
  });
});

describe("catalog:graduate, a research row corrected in the app", () => {
  // two rows as the hand research writes them, one key a line
  const duplex = [
    "    {",
    '      "brand": "Zpacks",',
    '      "name": "Duplex",',
    '      "variant": "",',
    '      "attributes": {"persons": 2},',
    '      "category_hint": "shelter",',
    '      "weight_value": 17.8,',
    '      "weight_unit": "oz",',
    '      "weight_secondary": "504 g",',
    '      "weight_source": "manufacturer",',
    '      "source_url": "https://zpacks.com/products/duplex-tent",',
    '      "quote": "Weight 17.8 oz / 504 g"',
    "    }",
  ].join("\n");
  const zip = [
    "    {",
    '      "brand": "Zpacks",',
    '      "name": "Duplex Zip",',
    '      "variant": "",',
    '      "category_hint": "shelter",',
    '      "weight_value": 20.4,',
    '      "weight_unit": "oz",',
    '      "weight_source": "manufacturer",',
    '      "source_url": "https://zpacks.com/products/duplex-zip-tent",',
    '      "quote": "Weight 20.4 oz / 578 g"',
    "    }",
  ].join("\n");
  const pretty = `{\n  "_comment": "Shelters, \\"quoted\\" {braces} and [brackets] in a string.",\n  "rows": [\n${duplex},\n${zip}\n  ]\n}\n`;
  // the row as asResearchRow writes it out of the database
  const corrected: ResearchRow = { brand: "Zpacks", name: "Duplex", variant: null, category_hint: "shelter", common_name: "Tent", weight_value: 524, weight_unit: "g", weight_source: "manufacturer", source_url: "https://zpacks.com/products/duplex-tent-2026", quote: "Weight 18.5 oz / 524 g" };
  const by = (...rows: ResearchRow[]) => new Map(rows.map((r) => [researchIdentity(r), r]));

  const rowsOf = (raw: string) => JSON.parse(raw).rows as ResearchRow[];

  it("gives the matching row the app's weight and citation, and leaves every other key and row", () => {
    const held = rowsOf(pretty);
    const { rows, replaced, before } = rewriteResearchRows(held, by(corrected));
    expect([...replaced]).toEqual([researchIdentity(corrected)]);
    // its own keys in its own order, the stale weight_secondary gone, and nothing taken
    // from the graduated row but the weight and its citation (no common_name, no null variant)
    expect(Object.entries(rows[0] as ResearchRow)).toEqual([
      ["brand", "Zpacks"],
      ["name", "Duplex"],
      ["variant", ""],
      ["attributes", { persons: 2 }],
      ["category_hint", "shelter"],
      ["weight_value", 524],
      ["weight_unit", "g"],
      ["weight_source", "manufacturer"],
      ["source_url", "https://zpacks.com/products/duplex-tent-2026"],
      ["quote", "Weight 18.5 oz / 524 g"],
    ]);
    // the other row is the one passed in, and so is the list: nothing is changed in place
    expect(rows[1]).toBe(held[1]);
    expect(held).toEqual(rowsOf(pretty));
    // what the row said before, as the build reads it
    expect([...before]).toEqual([[researchIdentity(corrected), { weightMg: specToMg(17.8, "oz", "504 g"), sourceUrl: "https://zpacks.com/products/duplex-tent" }]]);
    // still research, and the audit reads the new quote as backing the new weight
    expect(runResearchChecks([{ file: "shelters.json", rows: rows as ResearchRow[] }]).filter((f) => f.level === "error")).toEqual([]);
    // a quote the graduated row doesn't have goes, rather than standing beside a weight it doesn't state
    const unquoted = rewriteResearchRows(held, by({ ...corrected, quote: undefined })).rows;
    expect(unquoted[0]).not.toHaveProperty("quote");
  });

  it("finds a row by the size as the build reads it, and lists what it replaced from the end of the file", () => {
    const elevate = { brand: "Hyperlite Mountain Gear", name: "Elevate 22", variant: "M", attributes: { volume_l: 22 }, category_hint: "pack", common_name: "backpack", weight_value: 502, weight_unit: "g", weight_secondary: "17.7 oz", weight_source: "manufacturer", source_url: "https://www.hyperlitemountaingear.com/products/elevate-22", quote: "Weight 17.7oz | 502g" };
    const hat = { brand: "Sunday Afternoons", name: "Adventure Hat", variant: "", category_hint: "clothing", common_name: "sun hat", weight_value: 85, weight_unit: "g", weight_secondary: "3.0 oz", weight_source: "manufacturer", source_url: "https://www.sundayafternoons.com/products/adventure-hat", quote: "Adjustable sizing Weight: 3.0 ounces/85.0 grams" };
    const tight = { brand: "Hyperlite Mountain Gear", name: "Elevate 22", variant: "Large", category_hint: "pack", weight_value: 520, weight_unit: "g", weight_source: "manufacturer", source_url: "https://www.hyperlitemountaingear.com/products/elevate-22", quote: "Weight 520g" };
    // the database holds the size as the build wrote it, "Medium" for the research's "M"
    const medium: ResearchRow = { brand: "Hyperlite Mountain Gear", name: "Elevate 22", variant: "Medium", category_hint: "pack", common_name: "Backpack", weight_value: 510, weight_unit: "g", weight_source: "manufacturer", source_url: "https://www.hyperlitemountaingear.com/products/elevate-22", quote: "Weight 18oz | 510g" };
    const large: ResearchRow = { ...medium, variant: "Large", weight_value: 530, quote: "Weight 530g" };
    const { rows, replaced } = rewriteResearchRows([elevate, hat, tight], by(medium, large));
    // the last row of the file first: the order the run names them in
    expect([...replaced]).toEqual([researchIdentity(large), researchIdentity(medium)]);
    const { weight_secondary: _stale, ...kept } = elevate;
    // the research's own "M" and gear type stay; only the weight and its quote are the app's
    expect(rows).toEqual([{ ...kept, weight_value: 510, quote: "Weight 18oz | 510g" }, hat, { ...tight, weight_value: 530, quote: "Weight 530g" }]);
    expect(rows[1]).toBe(hat);
    expect(runResearchChecks([{ file: "adds.json", rows: rows as ResearchRow[] }]).filter((f) => f.code === "quote")).toEqual([]);
  });

  it("sends a row the research has back into its file, and a new one to verified-in-app.json", () => {
    const graduatedRaw = `${JSON.stringify({ _comment: "Rows verified in the app.", rows: [{ brand: "Toaks", name: "Titanium 750 Pot", variant: null, weight_value: 90 }] }, null, 2)}\n`;
    const xmid: ResearchRow = { brand: "Durston", name: "X-Mid 2", variant: null, category_hint: "shelter", common_name: "Tent", weight_value: 1022, weight_unit: "g", weight_source: "manufacturer", source_url: "https://durstongear.com/products/x-mid-2", quote: "Total Weight: 36 oz / 1022 g" };
    const pot: ResearchRow = { brand: "Toaks", name: "Titanium 750 Pot", variant: null, weight_value: 103 };
    // verified-in-app.json among the files is the graduated file, never rewritten in place
    const files = [{ file: "shelters.json", raw: pretty }, { file: "verified-in-app.json", raw: graduatedRaw }];
    const plan = planGraduation([corrected, xmid, pot], files);
    expect([...plan.inPlace]).toEqual([["shelters.json", 1]]);
    expect(plan.toGraduated).toBe(2);
    expect([...plan.writes.keys()].sort()).toEqual(["shelters.json", "verified-in-app.json"]);
    // the whole file in the house layout (catalog:format): the corrected row with the app's
    // weight and citation, the other row as it was, an empty variant left out of both
    const rewritten = [
      "    {",
      '      "brand": "Zpacks",',
      '      "name": "Duplex",',
      '      "attributes": {"persons": 2},',
      '      "category_hint": "shelter",',
      '      "weight_value": 524,',
      '      "weight_unit": "g",',
      '      "weight_source": "manufacturer",',
      '      "source_url": "https://zpacks.com/products/duplex-tent-2026",',
      '      "quote": "Weight 18.5 oz / 524 g"',
      "    }",
    ].join("\n");
    const noVariant = (row: string) => row.replace('      "variant": "",\n', "");
    expect(plan.writes.get("shelters.json")).toBe(pretty.replace(duplex, rewritten).replace(zip, noVariant(zip)));
    for (const text of plan.writes.values()) expect(text).toBe(formatResearchFile(JSON.parse(text)));
    // a file already in that layout, as every research file is, differs only in the row
    const house = formatResearchFile(JSON.parse(pretty));
    expect(planGraduation([corrected], [{ file: "shelters.json", raw: house }]).writes.get("shelters.json")).toBe(house.replace(noVariant(duplex), rewritten));
    // one that isn't JSON stops the run before anything is written
    expect(() => planGraduation([corrected], [{ file: "broken.json", raw: '{"rows": [' }, ...files])).toThrow(SyntaxError);
    const graduated = JSON.parse(plan.writes.get("verified-in-app.json")!);
    expect(graduated._comment).toBe("Rows verified in the app.");
    expect(graduated.rows.map((r: ResearchRow) => [r.name, r.weight_value])).toEqual([["Titanium 750 Pot", 103], ["X-Mid 2", 1022]]);
    expect(plan.writes.get("verified-in-app.json")!.endsWith("}\n")).toBe(true);
    // nothing to graduate: nothing written
    expect(planGraduation([], files)).toEqual({ writes: new Map(), inPlace: new Map(), toGraduated: 0, overwrites: [] });
    // no verified-in-app.json yet: the file is started, under its own comment
    const started = JSON.parse(planGraduation([xmid], [files[0]!]).writes.get("verified-in-app.json")!);
    expect([started._comment, started.rows.length]).toEqual(["Rows verified in the app (verify_catalog_item), written out by npm run catalog:graduate.", 1]);
  });

  it("names each row it writes over, and marks one whose research changed after the verification", () => {
    const research = { weightMg: specToMg(17.8, "oz", "504 g"), sourceUrl: "https://zpacks.com/products/duplex-tent" };
    const app = { weightMg: 524_000, sourceUrl: "https://zpacks.com/products/duplex-tent-2026" };
    const files = [{ file: "shelters.json", raw: pretty }];
    const key = researchIdentity(corrected);
    // the maker re-specced it: the research still says what the row held when it was verified
    expect(planGraduation([corrected], files, new Map([[key, research]])).overwrites).toEqual([
      { file: "shelters.json", key, research, app, whenVerified: research, researchMoved: false },
    ]);
    // a research PR changed the row after the verification, and graduating would undo it
    const then = { weightMg: 500_000, sourceUrl: research.sourceUrl };
    expect(planGraduation([corrected], files, new Map([[key, then]])).overwrites[0]).toMatchObject({ whenVerified: then, researchMoved: true });
    expect(planGraduation([corrected], files, new Map([[key, { ...research, sourceUrl: "https://zpacks.com/old" }]])).overwrites[0]!.researchMoved).toBe(true);
    // no edit history to go by: listed, not marked
    expect(planGraduation([corrected], files).overwrites[0]).toMatchObject({ whenVerified: null, researchMoved: false });
  });
});

describe("catalog:graduate, what the database says about the research", () => {
  it("reads the research a row's latest verification stamp replaced, and nothing for a product the tool added", async () => {
    const db = await createTestDb(CATALOG_DDL);
    const duplex = await seedCatalogRow(db, { brand: "Zpacks", name: "Duplex", weightMg: 524_000, weightSource: "manufacturer", sourceUrl: "https://zpacks.com/products/duplex-tent-2026", verified: true, verifiedBy: 7 });
    const pot = await seedCatalogRow(db, { brand: "Toaks", name: "Titanium 750 Pot", weightMg: 103_000, weightSource: "measured", verified: true, verifiedBy: 7 });
    const edit = (catalogItemId: number, oldWeightMg: number, newWeightMg: number, undo: schema.CatalogEditUndo, status = "applied") =>
      db.insert(schema.catalogEdits).values({ catalogItemId, oldWeightMg, newWeightMg, status, undo });
    const was = (sourceUrl: string) => ({ verified: true, verifiedBy: null, sourceUrl });
    // stamped once, graduated, stamped again; an undone stamp; then a re-verification of the
    // row while it was already in the app, whose snapshot isn't the research's
    await edit(duplex.id, 500_000, 504_000, was("https://zpacks.com/products/duplex"));
    await edit(duplex.id, 504_000, 520_000, was("https://zpacks.com/products/duplex-tent"));
    await edit(duplex.id, 520_000, 530_000, was("https://zpacks.com/products/duplex-tent"), "reverted");
    await edit(duplex.id, 520_000, 524_000, { verified: true, verifiedBy: 7, sourceUrl: "https://zpacks.com/products/duplex-tent" });
    await edit(pot.id, 103_000, 103_000, { status: "removed" });

    const inApp = await inAppVerified(db as never);
    expect([...(await researchWhenVerified(db as never, inApp))]).toEqual([
      [researchIdentity(duplex), { weightMg: 504_000, sourceUrl: "https://zpacks.com/products/duplex-tent" }],
    ]);
    // the reseed's question: which in-app rows the research doesn't have at all
    expect(notInResearch(inApp, [{ brand: "Zpacks", name: "Duplex", variant: null }]).map((r) => r.name)).toEqual(["Titanium 750 Pot"]);
  });
});
