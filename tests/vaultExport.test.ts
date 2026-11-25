// My Gear, out — the CSV and the JSON behind /gear's Export menu.
//
// The load-bearing claim is the round trip: the CSV's headers are deliberately the
// ones csvToListData already reads, so "everything I own" can come back as a list.
// That only stays true while both files agree, which is what the first test is for.

import { describe, expect, it } from "vitest";
import { vaultRow as row } from "./helpers/vault";
import { csvToListData } from "../shared/exporters/csv";
import { vaultToCsv, vaultToJson } from "../shared/exporters/vault";
import type { VaultEntry } from "../shared/vault";

const lines = (csv: string) => csv.split("\n");
const cells = (csv: string, n: number) => lines(csv)[n]!.split(",");

describe("vaultToCsv", () => {
  it("re-imports as a list — the headers are the importer's own", () => {
    const csv = vaultToCsv(
      {
        items: [
          row({ name: "Duplex", brand: "Zpacks", commonName: "Tent" }),
          row({ name: "Bar", commonName: "Snack", weightMg: 68_000, classification: "consumable", kcal: 250 }),
        ],
      },
      "g",
    );
    const list = csvToListData(csv);
    expect(list.items.map((i) => i.name)).toEqual(["Duplex", "Bar"]);
    expect(list.items[0]!.brand).toBe("Zpacks");
    expect(list.items[0]!.commonName).toBe("Tent");
    expect(list.items[0]!.unitWeightMg).toBe(539_000);
    // each piece's KIND is its folder, so the list lands grouped the way /gear is
    expect(list.folders.map((f) => f.name)).toEqual(["Shelter", "Food"]);
    // the consumable's class and its calories survive the trip
    expect(list.items[1]!.classification).toBe("consumable");
    expect(list.items[1]!.kcal).toBe(250);
  });

  it("orders rows the way the page does: kits, then each kind, then Other", () => {
    const csv = vaultToCsv(
      {
        items: [
          row({ name: "Widget", commonName: "Widget" }),
          row({ name: "Mug", commonName: "Cup" }),
          row({ name: "Duplex", commonName: "Tent" }),
          row({ name: "Cook kit", kind: "kit", parts: [] }),
        ],
      },
      "g",
    );
    const list = csvToListData(csv);
    expect(list.items.map((i) => i.name)).toEqual(["Cook kit", "Duplex", "Mug", "Widget"]);
    expect(list.folders.map((f) => f.name)).toEqual(["Kits", "Shelter", "Kitchen", "Other"]);
  });

  it("writes the price as a bare number, with the currency in its own column", () => {
    const csv = vaultToCsv(
      { items: [row({ priceCents: 39_900, currency: "USD" })] },
      "g",
    );
    const header = cells(csv, 0);
    const data = cells(csv, 1);
    // a spreadsheet has to be able to add the column up, so no symbol rides in it
    expect(data[header.indexOf("Price")]).toBe("399.00");
    expect(data[header.indexOf("Currency")]).toBe("USD");
  });

  it("carries the link and the use count, with the list CSV's Note column left empty", () => {
    const csv = vaultToCsv(
      {
        items: [
          row({
            productUrl: "https://example.com/tent",
            timesSeen: 7,
          }),
        ],
      },
      "g",
    );
    const header = cells(csv, 0);
    const data = cells(csv, 1);
    // My Gear keeps no note; the column holds its place so the file reads as a list's
    expect(data[header.indexOf("Note")]).toBe("");
    expect(data[header.indexOf("URL")]).toBe("https://example.com/tent");
    expect(data[header.indexOf("Times Used")]).toBe("7");
    // the day, not the instant — the column answers "when did I last pack this"
    expect(data[header.indexOf("Last Used")]).toBe("2026-08-01");
    // how many you own, one when the piece doesn't say
    expect(data[header.indexOf("Qty")]).toBe("1");
  });

  it("de-fangs a cell a spreadsheet would run as a formula", () => {
    const csv = vaultToCsv({ items: [row({ name: "=cmd|' /c calc'!A1" })] }, "g");
    // the leading quote is the standard CSV-injection mitigation; nothing else about
    // the cell needs quoting, so it doesn't get any
    expect(csv).toContain(",'=cmd|' /c calc'!A1,");
  });

  it("quotes a cell holding a comma", () => {
    const csv = vaultToCsv({ items: [row({ name: "Tarp, patched" })] }, "g");
    expect(csv).toContain('"Tarp, patched"');
  });

  it("exports every row in the page's unit", () => {
    const csv = vaultToCsv({ items: [row({ weightMg: 539_000 })] }, "oz");
    const header = cells(csv, 0);
    const data = cells(csv, 1);
    expect(data[header.indexOf("Unit")]).toBe("oz");
    expect(Number(data[header.indexOf("Weight")])).toBeCloseTo(19.013, 2);
  });

  it("leaves the weight and unit columns empty for gear you haven't weighed", () => {
    const csv = vaultToCsv({ items: [row({ weightMg: 0 })] }, "g");
    const header = cells(csv, 0);
    const data = cells(csv, 1);
    expect(data[header.indexOf("Weight")]).toBe("");
    expect(data[header.indexOf("Unit")]).toBe("");
  });
});

describe("vaultToJson", () => {
  it("keeps every field the API returns, in the page's order", () => {
    const json = JSON.parse(
      vaultToJson({
        items: [row({ name: "Widget", commonName: "Widget" }), row({ name: "Duplex", commonName: "Tent", pinned: ["weight"] })],
      }),
    );
    expect(json.items.map((i: VaultEntry) => i.name)).toEqual(["Duplex", "Widget"]);
    // My Gear has no folders, so a backup carries none
    expect(json.folders).toBeUndefined();
    // a backup that dropped the pins would restore gear your lists could overwrite
    expect(json.items[0].pinned).toEqual(["weight"]);
    expect(json.items[0].timesSeen).toBe(1);
  });
});

describe("vaultToCsv weights survive the round trip", () => {
  // Grams once went out at zero decimals, so a 0.4 g piece exported as 0 and came back
  // unweighed. The list exporter's decimals, per unit, are what toMg() reads back exactly.
  it.each([
    ["g", 400],
    ["g", 12_345],
    ["kg", 12_345],
    ["oz", 9_071],
    ["lb", 453_592],
  ] as const)("in %s a %d mg piece re-imports at the same milligrams", (unit, weightMg) => {
    const csv = vaultToCsv({ items: [row({ name: "Tab", weightMg })] }, unit);
    expect(csvToListData(csv).items[0]!.unitWeightMg).toBe(weightMg);
  });

  it("still writes a whole-gram weight with no trailing zeros", () => {
    const csv = vaultToCsv({ items: [row({ name: "Duplex", weightMg: 539_000 })] }, "g");
    expect(cells(csv, 1)).toContain("539");
  });
});
