// Putting gear back — the parse half, and the round trip it exists to close.
//
// The load-bearing claim is that a file /gear just handed you comes back in as the
// gear it left as. Both formats are tested against the EXPORTER rather than against
// hand-written fixtures, so the two can't drift apart without a failure here.

import { describe, expect, it } from "vitest";
import { vaultToCsv, vaultToJson } from "../shared/exporters/vault";
import { parseVaultImport, vaultImportFromCsv, vaultImportFromJson } from "../shared/vaultImport";
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

describe("vaultImportFromJson — our own backup, back", () => {
  const gear = {
    items: [
      row({
        name: "Duplex",
        brand: "Zpacks",
        commonName: "Tent",
        folderId: 1,
        description: "Seam-sealed 2024",
        priceCents: 69_900,
        currency: "USD",
        productUrl: "https://example.com/tent",
        imageUrl: "https://example.com/tent.jpg",
        pinned: ["weight", "price"],
      }),
      row({ name: "Bar", classification: "consumable", kcal: 250, weightMg: 68_000 }),
    ],
    folders: [folder(1, "Shelter")],
  };

  it("carries every field the export wrote", () => {
    const back = vaultImportFromJson(vaultToJson(gear))!;
    expect(back.from).toBe("json");
    const tent = back.rows.find((r) => r.name === "Duplex")!;
    expect(tent.brand).toBe("Zpacks");
    expect(tent.commonName).toBe("Tent");
    expect(tent.weightMg).toBe(539_000);
    expect(tent.description).toBe("Seam-sealed 2024");
    expect(tent.priceCents).toBe(69_900);
    expect(tent.currency).toBe("USD");
    expect(tent.productUrl).toBe("https://example.com/tent");
    expect(tent.imageUrl).toBe("https://example.com/tent.jpg");
  });

  it("resolves a folder id back to its NAME", () => {
    // ids belong to the vault that issued them; a name is the only currency the
    // server's find-or-create speaks
    const back = vaultImportFromJson(vaultToJson(gear))!;
    expect(back.rows.find((r) => r.name === "Duplex")!.folder).toBe("Shelter");
    expect(back.rows.find((r) => r.name === "Bar")!.folder).toBeUndefined();
  });

  it("restores the pins — most of what makes a backup faithful", () => {
    const back = vaultImportFromJson(vaultToJson(gear))!;
    expect(back.rows.find((r) => r.name === "Duplex")!.pinned).toEqual(["weight", "price"]);
  });

  it("never trusts a normKey from a file", () => {
    // the identity is re-derived server-side from the spelling; a forged key could
    // otherwise collide two unrelated rows or dodge a tombstone
    const back = vaultImportFromJson(
      JSON.stringify({ folders: [], items: [{ name: "Duplex", normKey: "something else" }] }),
    )!;
    expect(back.rows[0]!.normKey).toBe("");
  });

  it("drops a pin token that isn't one, and rows with no name", () => {
    const back = vaultImportFromJson(
      JSON.stringify({
        folders: [],
        items: [{ name: "Duplex", pinned: ["weight", "nonsense"] }, { name: "  " }, {}],
      }),
    )!;
    expect(back.rows).toHaveLength(1);
    expect(back.rows[0]!.pinned).toEqual(["weight"]);
  });

  it("returns null for JSON that isn't ours, so the caller can try CSV", () => {
    expect(vaultImportFromJson("{}")).toBeNull();
    expect(vaultImportFromJson("not json")).toBeNull();
  });
});

describe("vaultImportFromCsv — any spreadsheet, as gear", () => {
  it("reads back the CSV /gear just wrote", () => {
    const csv = vaultToCsv(
      {
        items: [
          row({ name: "Duplex", brand: "Zpacks", commonName: "Tent", folderId: 1 }),
          row({ name: "Bar", classification: "consumable", kcal: 250, weightMg: 68_000 }),
        ],
        folders: [folder(1, "Shelter")],
      },
      "g",
    );
    const back = vaultImportFromCsv(csv);
    expect(back.from).toBe("csv");
    expect(back.rows.map((r) => r.name)).toEqual(["Duplex", "Bar"]);
    expect(back.rows[0]!.brand).toBe("Zpacks");
    expect(back.rows[0]!.folder).toBe("Shelter");
    expect(back.rows[0]!.weightMg).toBe(539_000);
    expect(back.rows[1]!.kcal).toBe(250);
  });

  it("keeps gear you own but haven't weighed", () => {
    // capture's worthiness rule would drop these — it exists to keep half-typed
    // rows out of a vault while you type, and nothing in a chosen file is half-typed
    const back = vaultImportFromCsv("Item Name,Weight\nMYOG quilt,\nTitanium spork,");
    expect(back.rows.map((r) => r.name)).toEqual(["MYOG quilt", "Titanium spork"]);
    expect(back.rows[0]!.weightMg).toBe(0);
  });

  it("states no pins — a CSV records values, not decisions", () => {
    const back = vaultImportFromCsv("Item Name,Weight,Unit\nDuplex,539,g");
    expect(back.rows[0]!.pinned).toBeUndefined();
  });
});

describe("parseVaultImport — the sniff", () => {
  it("reads a JSON backup as JSON and anything else as CSV", () => {
    expect(parseVaultImport(vaultToJson({ items: [row()], folders: [] })).from).toBe("json");
    expect(parseVaultImport("Item Name,Weight\nDuplex,539").from).toBe("csv");
  });

  it("falls through to CSV for JSON that isn't a gear backup", () => {
    expect(parseVaultImport('{"nope":1}').rows).toEqual([]);
  });
});
