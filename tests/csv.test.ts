import { describe, expect, it } from "vitest";
import { csvToListData, listToCsv, parseCsv } from "../shared/exporters/csv";
import type { ListSnapshot } from "../shared/types";
import { toMg } from "../shared/weights";

const snap = (): ListSnapshot => ({
  shareCode: "X",
  slug: "x",
  version: 1,
  isPublic: false,
  title: "Trip",
  displayUnit: "g",
  folders: [
    { id: "f1", name: "Shelter", defaultClassification: "base", sortOrder: 0 },
    { id: "f2", name: "On Body", defaultClassification: "worn", sortOrder: 1 },
  ],
  items: [
    { id: "i1", folderId: "f1", name: "Zpacks Duplex", unitWeightMg: 538000, qty: 1, classification: null, sortOrder: 0 },
    { id: "i2", folderId: "f2", name: "Rain jacket", unitWeightMg: 300000, qty: 1, classification: null, sortOrder: 0 },
  ],
});

describe("parseCsv", () => {
  it("handles quoted fields with commas and escaped quotes", () => {
    const rows = parseCsv('a,b\n"x, y","he said ""hi"""');
    expect(rows[1]).toEqual(["x, y", 'he said "hi"']);
  });
});

describe("CSV round-trip", () => {
  it("export → import preserves folders, weights, and classification", () => {
    const data = csvToListData(listToCsv(snap()));
    expect(data.folders.map((f) => f.name).sort()).toEqual(["On Body", "Shelter"]);
    const duplex = data.items.find((i) => i.name === "Zpacks Duplex")!;
    expect(duplex.unitWeightMg).toBe(538000);
    const jacket = data.items.find((i) => i.name === "Rain jacket")!;
    // "On Body" defaults worn → export writes Worn=1 → import sets classification worn
    expect(jacket.classification).toBe("worn");
  });

  it("round-trips a worn split via its own Worn Qty column", () => {
    const s = snap();
    s.items.push({ id: "i3", folderId: "f1", name: "Socks", unitWeightMg: 100000, qty: 3, wornQty: 1, classification: null, sortOrder: 1 });
    const csv = listToCsv(s);
    expect(csv.split("\n")[0]).toContain("Worn Qty");
    const data = csvToListData(csv);
    const socks = data.items.find((i) => i.name === "Socks")!;
    expect(socks.wornQty).toBe(1);
    expect(socks.classification).toBeNull(); // still a base row, NOT fully worn
    // the fully-worn jacket keeps the boolean Worn column and gains no split
    const jacket = data.items.find((i) => i.name === "Rain jacket")!;
    expect(jacket.classification).toBe("worn");
    expect(jacket.wornQty).toBeUndefined();
  });

  it("round-trips the gear type via its own Gear Type column, pinned as the user's", () => {
    const s = snap();
    s.items[0]!.commonName = "Tent";
    const csv = listToCsv(s);
    expect(csv.split("\n")[0]).toContain("Gear Type");
    const duplex = csvToListData(csv).items.find((i) => i.name === "Zpacks Duplex")!;
    expect(duplex.commonName).toBe("Tent");
    // an imported label is the user's, so a later catalog re-link can't overwrite it
    expect(duplex.commonNameOverridden).toBe(true);
    // a row with no gear type gains neither the value nor the flag
    const jacket = csvToListData(csv).items.find((i) => i.name === "Rain jacket")!;
    expect(jacket.commonName).toBeUndefined();
    expect(jacket.commonNameOverridden).toBeUndefined();
  });
});

describe("CSV gear-type column aliases", () => {
  // "Common Name" was this column's header before the rename — files exported then must
  // keep importing, which is the whole reason the alias list exists.
  it("accepts the legacy Common Name header", () => {
    const data = csvToListData("Item Name,Common Name,Weight,Unit\nZpacks Duplex,Tent,538,g");
    expect(data.items[0]!.commonName).toBe("Tent");
  });

  // ...but NOT a bare "Type" column: that's a very common spelling of CATEGORY in
  // third-party gear spreadsheets, and a wrong hit gets stamped overridden, which would
  // pin the mis-mapped value against every later correction.
  it("ignores a bare Type column", () => {
    const data = csvToListData("Item Name,Type,Weight,Unit\nZpacks Duplex,Shelter,538,g");
    expect(data.items[0]!.commonName).toBeUndefined();
    expect(data.items[0]!.commonNameOverridden).toBeUndefined();
  });
});

describe("CSV row order", () => {
  it("follows folder sortOrder (not array order) and appends ungrouped rows last", () => {
    const s = snap();
    s.folders[0]!.sortOrder = 1;
    s.folders[1]!.sortOrder = 0;
    s.items.push({ id: "i9", folderId: null, name: "Loose spork", unitWeightMg: 18000, qty: 1, classification: null, sortOrder: 0 });
    const names = listToCsv(s).split("\n").slice(1).map((r) => r.split(",")[1]);
    expect(names).toEqual(["Rain jacket", "Zpacks Duplex", "Loose spork"]);
  });
});

describe("CSV formula-injection guard", () => {
  it("neutralizes formula-leading cells on export and strips the guard on import", () => {
    const s = snap();
    s.items[0]!.name = "=HYPERLINK(\"http://evil\",\"x\")"; // classic CSV injection
    s.items[1]!.name = "+1234567890";
    const csv = listToCsv(s);
    // every data cell that started with a formula char is quote-prefixed in the export
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+1234567890");
    // and the guard is removed on re-import (lossless round-trip)
    const data = csvToListData(csv);
    expect(data.items.some((i) => i.name === "=HYPERLINK(\"http://evil\",\"x\")")).toBe(true);
    expect(data.items.some((i) => i.name === "+1234567890")).toBe(true);
  });
});

describe("LighterPack CSV import", () => {
  it("maps LighterPack headers + unit conversion + flags", () => {
    const lp = [
      "Item Name,Category,desc,qty,weight,unit,price,worn,consumable,star,image url,url",
      "Hyperlite 2400,Pack,Southwest,1,850,g,355,,,,,https://hmg.com",
      "Puffy,Worn,,1,10.6,oz,,1,,,,",
      "Bars,Food,,5,68,g,,,1,,,",
    ].join("\n");
    const data = csvToListData(lp);
    expect(data.folders.map((f) => f.name)).toEqual(["Pack", "Worn", "Food"]);
    const puffy = data.items.find((i) => i.name === "Puffy")!;
    expect(puffy.classification).toBe("worn");
    expect(puffy.unitWeightMg).toBe(toMg(10.6, "oz"));
    const bars = data.items.find((i) => i.name === "Bars")!;
    expect(bars.classification).toBe("consumable");
    expect(bars.qty).toBe(5);
    const pack = data.items.find((i) => i.name === "Hyperlite 2400")!;
    expect(pack.productUrl).toBe("https://hmg.com");
    // Mahonia doesn't do prices — a "price" column is dropped on import, not
    // silently carried (it would otherwise be invisible but re-exported).
    expect(pack.priceCents).toBeUndefined();
  });

  it("falls back to first column for the name when no name header", () => {
    const data = csvToListData("thing,grams\nSpork,18");
    expect(data.items[0]?.name).toBe("Spork");
  });

  it("recognizes the full unit vocabulary shared with weight entry (e.g. singular 'kilogram')", () => {
    // regression: the CSV importer used to miss "kilogram" (only "kilograms"/"kgs"),
    // silently falling back to grams. It now shares weights.UNIT_ALIASES.
    const data = csvToListData("name,weight,unit\nBear can,1.2,kilogram");
    expect(data.items[0]?.unitWeightMg).toBe(toMg(1.2, "kg"));
  });
});

describe("CSV: calories", () => {
  it("round-trips kcal on a consumable row", () => {
    const s = snap();
    s.folders.push({ id: "f3", name: "Food", defaultClassification: "consumable", sortOrder: 2 });
    s.items.push({ id: "i4", folderId: "f3", name: "Bars", unitWeightMg: 60000, qty: 4, classification: null, kcal: 250, sortOrder: 0 });
    const csv = listToCsv(s);
    expect(csv.split("\n")[0]).toContain("Kcal");
    const bars = csvToListData(csv).items.find((i) => i.name === "Bars")!;
    expect(bars.kcal).toBe(250);
  });

  it("does not export kcal from a row that isn't consumable", () => {
    // it's carried in the data (so re-promoting restores it) but it isn't true of
    // the row as exported, and computeTotals wouldn't count it either
    const s = snap();
    s.items[0]!.kcal = 999;
    const bodyRow = listToCsv(s).split("\n").find((r) => r.startsWith("Shelter"))!;
    expect(bodyRow.endsWith(",")).toBe(true);
  });

  it("imports a CSV with no Kcal column at all (the LighterPack case)", () => {
    const data = csvToListData("Item Name,Weight,Unit,Consumable\nBars,60,g,1");
    expect(data.items[0]?.kcal).toBeUndefined();
    expect(data.items[0]?.unitWeightMg).toBe(60000);
  });

  it("accepts 'Calories' as a header alias", () => {
    const data = csvToListData("Item Name,Weight,Unit,Consumable,Calories\nBars,60,g,1,250");
    expect(data.items[0]?.kcal).toBe(250);
  });
});

describe("CSV: per-row entry units", () => {
  it("exports each row in the unit it reads in, not the list's", () => {
    const s = snap(); // displayUnit "g"
    s.items[0]!.entryUnit = "oz";
    const row = listToCsv(s).split("\n").find((r) => r.includes("Zpacks Duplex"))!;
    const cols = row.split(",");
    expect(cols[6]).toBe("oz"); // Unit column
    expect(Number(cols[5])).toBeCloseTo(538000 / 28349.523125, 2);
  });

  it("round-trips the entry unit through the existing Unit column", () => {
    const s = snap();
    s.items[0]!.entryUnit = "oz";
    const duplex = csvToListData(listToCsv(s)).items.find((i) => i.name === "Zpacks Duplex")!;
    expect(duplex.entryUnit).toBe("oz");
    // and the weight survives the g → oz → g trip within rounding
    expect(duplex.unitWeightMg).toBeCloseTo(538000, -2);
  });

  it("does not pin every row when the whole file names ONE unit", () => {
    // Our export writes a Unit cell on every row, so a plain gram list came back with
    // every row carrying entryUnit "g" — after which the totals bar's unit switcher
    // moved the headline figure and left every row in grams. A unit shared by all the
    // rows is the LIST's, not a choice made on any of them.
    const s = snap(); // displayUnit "g", no row has an entryUnit
    const data = csvToListData(listToCsv(s));
    expect(data.items.length).toBeGreaterThan(1);
    for (const it of data.items) expect(it.entryUnit).toBeUndefined();
  });

  it("leaves entryUnit unset when the file names no unit", () => {
    // a unitless CSV made no choice — pinning every row to the fallback would
    // invent one, and the list's own unit already covers it
    const data = csvToListData("Item Name,Weight\nSpork,18");
    expect(data.items[0]?.entryUnit).toBeUndefined();
  });
});

// The CSV is the app's own interchange format, so a list that goes out and comes back
// must be the same list. Two things silently changed it: a row with no name was skipped
// on import (taking its weight with it), and the gram column was written at zero
// decimals, which claimed a sub-gram row weighed nothing.
describe("CSV round-trip — nothing changes weight", () => {
  const totalMg = (items: readonly { qty: number; unitWeightMg: number }[]) =>
    items.reduce((sum, i) => sum + i.qty * i.unitWeightMg, 0);

  it("keeps a row that has a weight but no name", () => {
    const list = snap();
    list.items.push({ id: "i3", folderId: "f1", name: "", unitWeightMg: 450_000, qty: 1, classification: null, sortOrder: 1 });
    const back = csvToListData(listToCsv(list));
    expect(back.items).toHaveLength(3);
    expect(totalMg(back.items)).toBe(totalMg(list.items));
  });

  it("still skips a wholly empty line", () => {
    const back = csvToListData(listToCsv(snap()) + "\n,,,,,,,,,,,,,,");
    expect(back.items).toHaveLength(2);
  });

  it("skips a spacer row that carries no name and no weight", () => {
    // a category-only separator line, and a stray row holding only a price — both are
    // layout in someone's spreadsheet, and both used to import as phantom 0 g items
    const sep = csvToListData("Category,Item Name,Qty,Weight,Unit\nShelter,,,,\nShelter,Tent,1,900,g");
    expect(sep.items.map((i) => i.name)).toEqual(["Tent"]);
    const priced = csvToListData("Category,Item Name,Qty,Weight,Unit,Price\n,,,,,$ 12.00\n,Tent,1,900,g,");
    expect(priced.items.map((i) => i.name)).toEqual(["Tent"]);
  });

  it("carries sub-gram and fractional weights back unchanged", () => {
    for (const [mg, unit] of [[1, "g"], [499, "g"], [12_345, "g"], [12_345, "oz"], [12_345, "kg"], [12_345, "lb"], [100_000_000, "lb"]] as const) {
      const list = snap();
      list.items = [{ id: "i1", folderId: null, name: "Item", unitWeightMg: mg, qty: 1, classification: null, sortOrder: 0, entryUnit: unit }];
      const back = csvToListData(listToCsv(list));
      expect(back.items[0]!.unitWeightMg, `${mg} mg in ${unit}`).toBe(mg);
    }
  });

  it("writes a whole-gram weight without decimal noise", () => {
    const csv = listToCsv(snap());
    expect(csv).toContain(",538,g,");
    expect(csv).not.toContain("538.000");
  });

  it("keeps a quantity of zero", () => {
    const list = snap();
    list.items[0]!.qty = 0;
    const back = csvToListData(listToCsv(list));
    expect(back.items.find((i) => i.name === "Zpacks Duplex")!.qty).toBe(0);
    expect(totalMg(back.items)).toBe(totalMg(list.items));
  });
});
