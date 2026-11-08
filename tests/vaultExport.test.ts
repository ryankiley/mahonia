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
    expect(list.folders.map((f) => f.name)).toEqual(["Shelter & sleep", "Food, water & kitchen"]);
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
    expect(list.folders.map((f) => f.name)).toEqual(["Kits", "Shelter & sleep", "Food, water & kitchen", "Other"]);
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

  it("carries the note, the link and the use count", () => {
    const csv = vaultToCsv(
      {
        items: [
          row({
            description: "Seam-sealed 2024",
            productUrl: "https://example.com/tent",
            timesSeen: 7,
          }),
        ],
      },
      "g",
    );
    const header = cells(csv, 0);
    const data = cells(csv, 1);
    expect(data[header.indexOf("Note")]).toBe("Seam-sealed 2024");
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
    const csv = vaultToCsv({ items: [row({ description: "green, patched" })] }, "g");
    expect(csv).toContain('"green, patched"');
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
