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
    expect(pack.priceCents).toBe(35500);
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
