// My Gear, out — the CSV and the JSON behind /gear's Export menu.
//
// The load-bearing claim is the round trip: the CSV's headers are deliberately the
// ones csvToListData already reads, so "everything I own" can come back as a list.
// That only stays true while both files agree, which is what the first test is for.

import { describe, expect, it } from "vitest";
import { csvToListData } from "../shared/exporters/csv";
import { vaultToCsv, vaultToJson } from "../shared/exporters/vault";
import type { VaultEntry, VaultFolder } from "../shared/vault";

let nextId = 1;
const row = (over: Partial<VaultEntry> = {}): VaultEntry => ({
  id: nextId++,
  normKey: `k${nextId}`,
  name: "Duplex",
  weightMg: 539_000,
  timesSeen: 1,
  lastUsedAt: "2026-08-01T12:30:00.000Z",
  createdAt: "2026-07-01T00:00:00.000Z",
  ...over,
});
const folder = (id: number, name: string): VaultFolder => ({ id, name });

const lines = (csv: string) => csv.split("\n");
const cells = (csv: string, n: number) => lines(csv)[n]!.split(",");

describe("vaultToCsv", () => {
  it("re-imports as a list — the headers are the importer's own", () => {
    const csv = vaultToCsv(
      {
        items: [
          row({ name: "Duplex", brand: "Zpacks", commonName: "Tent", folderId: 1 }),
          row({ name: "Bar", weightMg: 68_000, classification: "consumable", kcal: 250 }),
        ],
        folders: [folder(1, "Shelter")],
      },
      "g",
    );
    const list = csvToListData(csv);
    expect(list.items.map((i) => i.name)).toEqual(["Duplex", "Bar"]);
    expect(list.items[0]!.brand).toBe("Zpacks");
    expect(list.items[0]!.commonName).toBe("Tent");
    expect(list.items[0]!.unitWeightMg).toBe(539_000);
    expect(list.folders.map((f) => f.name)).toEqual(["Shelter", "Imported"]);
    // the consumable's class and its calories survive the trip
    expect(list.items[1]!.classification).toBe("consumable");
    expect(list.items[1]!.kcal).toBe(250);
  });

  it("orders rows the way the page does: folders first, unfiled last", () => {
    const csv = vaultToCsv(
      {
        items: [
          row({ name: "Loose" }),
          row({ name: "Filed", folderId: 2 }),
          row({ name: "AlsoFiled", folderId: 1 }),
        ],
        folders: [folder(1, "Shelter"), folder(2, "Cook")],
      },
      "g",
    );
    expect(lines(csv).slice(1).map((l) => l.split(",")[1])).toEqual([
      "AlsoFiled",
      "Filed",
      "Loose",
    ]);
  });

  it("drops a folder with nothing in it", () => {
    const csv = vaultToCsv({ items: [row({ name: "Loose" })], folders: [folder(1, "Empty")] }, "g");
    expect(csv).not.toContain("Empty");
  });

  it("writes the price as a bare number, with the currency in its own column", () => {
    const csv = vaultToCsv(
      { items: [row({ priceCents: 39_900, currency: "USD" })], folders: [] },
      "g",
    );
    const header = cells(csv, 0);
    const data = cells(csv, 1);
    // a spreadsheet has to be able to add the column up, so no symbol rides in it
    expect(data[header.indexOf("Price")]).toBe("399.00");
    expect(data[header.indexOf("Currency")]).toBe("USD");
  });

  it("carries the note, the links and the use count", () => {
    const csv = vaultToCsv(
      {
        items: [
          row({
            description: "Seam-sealed 2024",
            productUrl: "https://example.com/tent",
            imageUrl: "https://example.com/tent.jpg",
            timesSeen: 7,
          }),
        ],
        folders: [],
      },
      "g",
    );
    const header = cells(csv, 0);
    const data = cells(csv, 1);
    expect(data[header.indexOf("Note")]).toBe("Seam-sealed 2024");
    expect(data[header.indexOf("URL")]).toBe("https://example.com/tent");
    expect(data[header.indexOf("Image URL")]).toBe("https://example.com/tent.jpg");
    expect(data[header.indexOf("Times Used")]).toBe("7");
    // the day, not the instant — the column answers "when did I last pack this"
    expect(data[header.indexOf("Last Used")]).toBe("2026-08-01");
  });

  it("de-fangs a cell a spreadsheet would run as a formula", () => {
    const csv = vaultToCsv({ items: [row({ name: "=cmd|' /c calc'!A1" })], folders: [] }, "g");
    // the leading quote is the standard CSV-injection mitigation; nothing else about
    // the cell needs quoting, so it doesn't get any
    expect(csv).toContain(",'=cmd|' /c calc'!A1,");
  });

  it("quotes a cell holding a comma", () => {
    const csv = vaultToCsv({ items: [row({ description: "green, patched" })], folders: [] }, "g");
    expect(csv).toContain('"green, patched"');
  });

  it("exports every row in the page's unit", () => {
    const csv = vaultToCsv({ items: [row({ weightMg: 539_000 })], folders: [] }, "oz");
    const header = cells(csv, 0);
    const data = cells(csv, 1);
    expect(data[header.indexOf("Unit")]).toBe("oz");
    expect(Number(data[header.indexOf("Weight")])).toBeCloseTo(19.013, 2);
  });

  it("leaves the weight and unit columns empty for gear you haven't weighed", () => {
    const csv = vaultToCsv({ items: [row({ weightMg: 0 })], folders: [] }, "g");
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
        items: [row({ name: "Loose" }), row({ name: "Filed", folderId: 1, pinned: ["weight"] })],
        folders: [folder(1, "Shelter")],
      }),
    );
    expect(json.items.map((i: VaultEntry) => i.name)).toEqual(["Filed", "Loose"]);
    expect(json.folders).toEqual([{ id: 1, name: "Shelter" }]);
    // a backup that dropped the pins would restore gear your lists could overwrite
    expect(json.items[0].pinned).toEqual(["weight"]);
    expect(json.items[0].timesSeen).toBe(1);
  });
});
