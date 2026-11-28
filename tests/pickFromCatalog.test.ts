import { describe, expect, it } from "vitest";
import { pickFromCatalog, withCatalogPick, type CatalogPickOwn, type CatalogPickPlace, type CatalogPickRow } from "../shared/catalogMatch";
import type { ItemPatch } from "../shared/ops";
import type { Folder } from "../shared/types";
import { item } from "./helpers/list";

// The one rule for what a list row takes from the catalog product it is linked to: the
// editor's pick, the paste, an import and the connector all call it, each saying which
// values it keeps as its own. Every field, then the three points on which the copies it
// replaced disagreed: a consumable product's class, an equal kept weight, and calories.

const folders: Folder[] = [
  { id: "pack", name: "Pack", colorKey: "pack", defaultClassification: "base", sortOrder: 0 },
  { id: "food", name: "Food", colorKey: "food", defaultClassification: "consumable", sortOrder: 1 },
];
const inPack = { folderId: "pack", folders };
const inFood = { folderId: "food", folders };

const tent: CatalogPickRow = { id: 7, brand: "Zpacks", name: "Duplex", variant: "DCF", weightMg: 538_000, commonName: "Tent", categoryHint: "shelter", kcal: null };
const bar: CatalogPickRow = { id: 4, brand: "Clif", name: "Builders Bar", variant: null, weightMg: 68_000, commonName: "Energy bar", categoryHint: "consumable", kcal: 290 };
const rice: CatalogPickRow = { ...bar, id: 5, brand: "Knorr", name: "Rice Sides", kcal: null };

describe("pickFromCatalog", () => {
  const cases: { what: string; catalog: CatalogPickRow; own?: CatalogPickOwn; place?: CatalogPickPlace; want: ItemPatch; absent?: (keyof ItemPatch)[] }[] = [
    {
      what: "nothing kept: every value is the product's, linked at its weight",
      catalog: tent,
      want: { catalogItemId: 7, catalogWeightMgAtLink: 538_000, unitWeightMg: 538_000, weightOverridden: false, name: "Duplex", nameOverridden: false, brand: "Zpacks", variant: "DCF", commonName: "Tent", commonNameOverridden: false },
      absent: ["kcal", "classification"],
    },
    {
      what: "a product without a brand or variant clears the row's",
      catalog: { ...tent, brand: null, variant: null, commonName: null },
      want: { brand: "", variant: "", commonName: "", commonNameOverridden: false },
    },
    {
      what: "a kept weight that differs is overridden, the catalog's still the baseline",
      catalog: tent,
      own: { weightMg: 600_000 },
      want: { unitWeightMg: 600_000, weightOverridden: true, catalogWeightMgAtLink: 538_000 },
    },
    {
      what: "a kept weight equal to the catalog's is not overridden",
      catalog: tent,
      own: { weightMg: 538_000 },
      want: { unitWeightMg: 538_000, weightOverridden: false },
    },
    {
      what: "a kept name that differs is the owner's",
      catalog: tent,
      own: { name: "my tarp tent" },
      want: { name: "my tarp tent", nameOverridden: true },
    },
    {
      what: "a kept name that only differs in case is stored as given, not overridden",
      catalog: tent,
      own: { name: "duplex" },
      want: { name: "duplex", nameOverridden: false },
    },
    {
      what: "a kept brand and variant stand, an empty one clearing",
      catalog: tent,
      own: { brand: "", variant: "Solid" },
      want: { brand: "", variant: "Solid" },
    },
    {
      what: "a kept gear type stands without touching its flag",
      catalog: tent,
      own: { commonName: "Shelter" },
      want: { commonName: "Shelter" },
      absent: ["commonNameOverridden"],
    },
    {
      what: "the product's calories when nothing is kept",
      catalog: bar,
      want: { kcal: 290 },
    },
    {
      what: "a kept calorie figure stands over the product's",
      catalog: bar,
      own: { kcal: 240 },
      want: { kcal: 240 },
    },
    {
      what: "a kept none stands over the product's figure",
      catalog: bar,
      own: { kcal: null },
      want: { kcal: null },
    },
    {
      what: "a product with no calorie figure leaves the row's alone",
      catalog: rice,
      want: {},
      absent: ["kcal"],
    },
    {
      what: "a consumable product in a base folder is stored consumable",
      catalog: bar,
      want: { classification: "consumable" },
    },
    {
      what: "a consumable product in a food folder stores no class, following the folder",
      catalog: bar,
      place: inFood,
      want: { classification: null },
    },
    {
      what: "a consumable product in no folder is stored consumable",
      catalog: bar,
      place: { folderId: null, folders },
      want: { classification: "consumable" },
    },
    {
      what: "a class the caller set stands, null included",
      catalog: bar,
      own: { classification: null },
      want: { classification: null },
    },
    {
      what: "any other product leaves the class alone",
      catalog: tent,
      place: inFood,
      want: {},
      absent: ["classification"],
    },
  ];

  it.each(cases)("$what", ({ catalog, own = {}, place = inPack, want, absent = [] }) => {
    const out = pickFromCatalog(catalog, own, place);
    expect(out).toMatchObject(want);
    for (const key of absent) expect(out).not.toHaveProperty(key);
  });
});

describe("withCatalogPick", () => {
  it("lays a pick onto a row, a cleared field absent and the class kept as null", () => {
    const row = item({ id: "r", name: "duplex", brand: "Old", variant: "Old", classification: "base", kcal: 100 });
    const out = withCatalogPick(row, { brand: "", variant: "DCF", kcal: null, classification: null, catalogItemId: 7 });
    expect(out).not.toHaveProperty("brand");
    expect(out).not.toHaveProperty("kcal");
    expect(out).toMatchObject({ variant: "DCF", classification: null, catalogItemId: 7, name: "duplex" });
  });
});
