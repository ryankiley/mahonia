import { describe, expect, it } from "vitest";
import { twoFolderList as snap } from "./helpers/list";
import { csvToListData, listToCsv, parseCsv } from "../shared/exporters/csv";
import { MAX_FOLDERS, MAX_ITEMS } from "../shared/ops";
import { toMg } from "../shared/weights";

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

  // A spreadsheet saved in a locale that writes the decimal as a comma. Every comma was
  // stripped as a thousands separator, so a 1,5 kg can came in as 15 kg, ten times the
  // weight and no complaint. The weight field's own rule decides instead (parseDecimal).
  it("reads a decimal comma as the weight field does, and a thousands comma still", () => {
    const data = csvToListData(
      ['name,weight,unit,calories,consumable', 'Bear can,"1,5",kg,,', 'Tent,"1,360",g,,', 'Quilt,"1.234,5",g,,', 'Bars,"0,25",kg,"1,200",1', "Stove,73,g,,"].join("\n"),
    );
    const mg = (name: string) => data.items.find((i) => i.name === name)!.unitWeightMg;
    expect(mg("Bear can")).toBe(toMg(1.5, "kg"));
    expect(mg("Tent")).toBe(toMg(1360, "g"));
    expect(mg("Quilt")).toBe(toMg(1234.5, "g"));
    expect(mg("Bars")).toBe(toMg(0.25, "kg"));
    expect(mg("Stove")).toBe(toMg(73, "g"));
    expect(data.items.find((i) => i.name === "Bars")!.kcal).toBe(1200);
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
    const [header, ...body] = parseCsv(listToCsv(s));
    const row = body.find((r) => r[0] === "Shelter")!;
    expect(row[header!.indexOf("Kcal")]).toBe("");
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

// A count is a typed number like any other in the file: the rule in shared/typedNumber.
describe("CSV import: a quantity is read by the one number rule", () => {
  const qtyOf = (cell: string) =>
    csvToListData(`Category,Item Name,Qty,Weight,Unit\nFood,Matches,${cell},1,g`).items[0]!.qty;

  it("reads a comma before three digits as thousands, and before one or two as a decimal", () => {
    expect(qtyOf('"1,000"')).toBe(1000);
    expect(qtyOf('"1,5"')).toBe(2); // one and a half, rounded as a count
    expect(qtyOf("12")).toBe(12);
  });

  it("keeps a written 0, and takes an empty or unreadable cell as one", () => {
    expect(qtyOf("0")).toBe(0);
    expect(qtyOf("")).toBe(1);
    expect(qtyOf("a few")).toBe(1);
  });

  it("reads the worn count the same way", () => {
    const [socks] = csvToListData('Category,Item Name,Qty,Worn Qty,Weight,Unit\nClothes,Socks,"1,000","1,000",1,g').items;
    expect(socks!.wornQty).toBe(1000);
  });
});

describe("CSV import limits", () => {
  it("matches the persisted list caps before catalog matching or create", () => {
    const csv = [
      "Category,Item Name,Qty,Weight,Unit",
      ...Array.from(
        { length: MAX_ITEMS + 20 },
        (_, i) => `Folder ${i % (MAX_FOLDERS + 2)},Item ${i},1,1,g`,
      ),
    ].join("\n");
    const data = csvToListData(csv);

    expect(data.items).toHaveLength(MAX_ITEMS);
    expect(data.folders).toHaveLength(MAX_FOLDERS);
    // Categories after the folder cap degrade to unfiled, exactly as createList's
    // bulk normalizer does for an item pointing at an omitted folder.
    expect(data.items.find((i) => i.name === `Item ${MAX_FOLDERS}`)?.folderId).toBeNull();
  });
});

// What people actually paste into the import box, beyond our own CSV and LighterPack's:
// cells copied out of a spreadsheet, a CSV saved by a European Excel, a hand-made sheet
// whose weight header names its unit, and a list typed one item per line.
describe("CSV import: the shapes a pasted list arrives in", () => {
  const named = (text: string) =>
    csvToListData(text).items.map((i) => [i.name, i.qty, i.unitWeightMg]);

  it("reads cells copied out of a spreadsheet, which are tab-separated", () => {
    const tsv = "Category\tItem Name\tQty\tWeight\tUnit\nShelter\tQuilt 25F, Large\t1\t510\tg\nSleep\tPad\t1\t12\toz";
    const data = csvToListData(tsv);
    expect(data.folders.map((f) => f.name)).toEqual(["Shelter", "Sleep"]);
    expect(named(tsv)).toEqual([["Quilt 25F, Large", 1, 510_000], ["Pad", 1, toMg(12, "oz")]]);
  });

  it("reads a semicolon-separated CSV with decimal commas", () => {
    expect(named("Category;Item Name;Qty;Weight;Unit\nShelter;Tent;1;1,2;kg\nSleep;Quilt;1;0,6;kg")).toEqual([
      ["Tent", 1, 1_200_000],
      ["Quilt", 1, 600_000],
    ]);
  });

  it("takes a weight column's unit from its header when no Unit column says otherwise", () => {
    expect(named("Item,Weight (oz)\nTent,38")).toEqual([["Tent", 1, toMg(38, "oz")]]);
    expect(named("Item,weight_g\nTent,1080")).toEqual([["Tent", 1, 1_080_000]]);
    expect(named("Item,Grams\nTent,1080")).toEqual([["Tent", 1, 1_080_000]]);
    // a Unit cell on the row wins over the header
    expect(named("Item,Weight (oz),Unit\nTent,1080,g")).toEqual([["Tent", 1, 1_080_000]]);
    // a total is not a row's weight
    expect(named("Item,Total weight\nTent,1080")).toEqual([["Tent", 1, 0]]);
  });

  it("reads a weight cell that names its own unit", () => {
    expect(named("Item,Weight\nTent,21 oz\nStakes,1 lb 3 oz")).toEqual([
      ["Tent", 1, toMg(21, "oz")],
      ["Stakes", 1, toMg(19, "oz")],
    ]);
  });

  it("reads a list typed one item per line, first line included", () => {
    const notes = ["# Shelter", "- Tent 540 g", "- [ ] Stakes (85 g)", "Sleep:", "• Quilt 20 oz", "Socks ×2", "Water 2 L", "Headlamp"].join("\n");
    const data = csvToListData(notes);
    expect(data.folders.map((f) => f.name)).toEqual(["Shelter", "Sleep"]);
    expect(named(notes)).toEqual([
      ["Tent", 1, 540_000],
      ["Stakes", 1, 85_000],
      ["Quilt", 1, toMg(20, "oz")],
      ["Socks", 2, 0],
      ["Water", 1, 2_000_000],
      ["Headlamp", 1, 0],
    ]);
  });

  it("files a typed list with no headings under Imported, as a file with no Category column", () => {
    const data = csvToListData("Tent 540 g\nQuilt 20 oz");
    expect(data.folders.map((f) => f.name)).toEqual(["Imported"]);
    expect(data.items.every((i) => i.folderId === data.folders[0]!.id)).toBe(true);
  });

  it("reads a run of names on one line, as our plain-text copy and a typed comment write them", () => {
    const text = "Zpacks Duplex tent, Quilt (20F, 600 g), Clif Bloks ×4, Water 3 L\n\nBase weight 3.16 kg, 7.65 kg total";
    expect(named(text)).toEqual([
      ["Zpacks Duplex tent", 1, 0],
      ["Quilt (20F, 600 g)", 1, 0],
      ["Clif Bloks", 4, 0],
      ["Water", 1, 3_000_000],
    ]);
  });

  it("still reads a comma-separated first row it doesn't know as a header", () => {
    // "thing,stuff" is cells, not a typed item: the column names just aren't ours
    expect(named("thing,stuff\nSpork,18")).toEqual([["Spork", 1, 0]]);
    expect(csvToListData("not,a,list\n").items).toEqual([]);
  });
});

describe("CSV round trip: what a flat file used to lose", () => {
  it("puts a group's rows back inside it, telling two groups of one name apart by order", () => {
    const s = snap();
    s.items.push(
      { id: "m1", folderId: "f1", name: "Monday", description: "Meals", unitWeightMg: 0, qty: 1, classification: null, sortOrder: 5 },
      { id: "m1a", folderId: "f1", parentId: "m1", name: "Risotto", unitWeightMg: 213_000, qty: 1, classification: null, sortOrder: 0 },
      { id: "m2", folderId: "f1", name: "Monday", description: "Snacks", unitWeightMg: 0, qty: 1, classification: null, sortOrder: 6 },
      { id: "m2a", folderId: "f1", parentId: "m2", name: "Bloks", unitWeightMg: 60_000, qty: 1, classification: null, sortOrder: 0 },
      { id: "m2b", folderId: "f1", parentId: "m2", name: "Bar", unitWeightMg: 68_000, qty: 1, classification: null, sortOrder: 1 },
    );
    const data = csvToListData(listToCsv(s));
    const byId = new Map(data.items.map((i) => [i.id, i]));
    const insideOf = (name: string) => byId.get(data.items.find((i) => i.name === name)!.parentId!)!;
    expect(insideOf("Risotto").description).toBe("Meals");
    expect(insideOf("Bloks").description).toBe("Snacks");
    expect(insideOf("Bar").description).toBe("Snacks");
    expect(insideOf("Bar").folderId).toBe(data.folders.find((f) => f.name === "Shelter")!.id);
    expect(data.items.filter((i) => i.parentId).map((i) => i.sortOrder)).toEqual([0, 0, 1]);
  });

  it("brings a row in no folder back in no folder", () => {
    const s = snap();
    s.items.push({ id: "u", folderId: null, name: "Loose", unitWeightMg: 10_000, qty: 1, classification: null, sortOrder: 0 });
    const data = csvToListData(listToCsv(s));
    expect(data.items.find((i) => i.name === "Loose")!.folderId).toBeNull();
    expect(data.folders.map((f) => f.name)).not.toContain("Imported");
  });

  it("hands back the unit most rows were written in as the list's", () => {
    const s = snap();
    s.displayUnit = "lb";
    s.items[0]!.entryUnit = "oz";
    const data = csvToListData(listToCsv({ ...s, items: [...s.items, { id: "x", folderId: "f1", name: "Pad", unitWeightMg: 400_000, qty: 1, classification: null, sortOrder: 3 }] }));
    expect(data.displayUnit).toBe("lb");
    expect(data.items.find((i) => i.name === "Zpacks Duplex")!.entryUnit).toBe("oz");
    expect(data.items.find((i) => i.name === "Pad")!.entryUnit).toBeUndefined();
  });

  it("writes each weight at the fewest decimals that read back to the same milligrams", () => {
    const s = snap();
    s.displayUnit = "lb";
    s.items[0]!.unitWeightMg = 45_359; // 0.0999990 lb to six places
    const [header, row] = parseCsv(listToCsv(s));
    expect(row![header!.indexOf("Weight")]).toBe("0.1");
    expect(csvToListData(listToCsv(s)).items[0]!.unitWeightMg).toBe(45_359);
    for (const mg of [1, 45_359, 992_233, 1_587_573, 3_000_000]) {
      for (const unit of ["g", "kg", "oz", "lb"] as const) {
        const t = snap();
        t.items = [{ ...t.items[0]!, unitWeightMg: mg, entryUnit: unit }];
        expect(csvToListData(listToCsv(t)).items[0]!.unitWeightMg).toBe(mg);
      }
    }
  });

  it("adds a grams column a spreadsheet can sum, which the importer doesn't read", () => {
    const s = snap();
    s.items[0]!.entryUnit = "oz";
    const [header, ...rows] = parseCsv(listToCsv(s));
    expect(header!.at(-1)).toBe("Weight (g)");
    expect(rows.map((r) => r.at(-1))).toEqual(["538", "300"]);
    expect(csvToListData(listToCsv(s)).items[0]!.unitWeightMg).toBe(538_000);
  });
});
