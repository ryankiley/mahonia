import { describe, expect, it } from "vitest";
import { jsonToListImport, listToJson } from "../shared/exporters/json";
import { MAX_FOLDERS, MAX_ITEMS, UNIT_WEIGHT_MAX_MG, normalizeFolder, normalizeItem } from "../shared/ops";
import type { Item, ListSnapshot } from "../shared/types";

// A full-fidelity list: catalog links, override flags, packed state, folder
// colors/defaults, brand/variant splits, a worn split, an unfiled item. The
// content is passed through the same normalize helpers the server runs on every
// write, because that's the only shape a real "Download JSON" export can hold.
const snap = (): ListSnapshot => ({
  shareCode: "X",
  slug: "x",
  version: 7,
  isPublic: true,
  title: "Sierra loop",
  description: "Late-season kit — bring the warm puffy.",
  displayUnit: "oz",
  folders: [
    { id: "f1", name: "Shelter", colorKey: "moss", defaultClassification: "base", sortOrder: 0 },
    { id: "f2", name: "On Body", colorKey: "sky", defaultClassification: "worn", sortOrder: 1 },
  ].map(normalizeFolder),
  items: (
    [
      {
        id: "i1",
        folderId: "f1",
        name: "Duplex",
        brand: "Zpacks",
        variant: "DCF 0.75",
        nameOverridden: true,
        unitWeightMg: 538_000,
        weightOverridden: true,
        qty: 1,
        classification: null,
        description: "seam-sealed",
        productUrl: "https://zpacks.com/duplex",
        imageUrl: "https://cdn.example/duplex.jpg",
        priceCents: 66_900,
        currency: "USD",
        catalogItemId: 42,
        catalogWeightMgAtLink: 539_000,
        packed: true,
        sortOrder: 0,
      },
      { id: "i2", folderId: "f1", name: "Socks", unitWeightMg: 80_000, qty: 3, wornQty: 1, classification: null, sortOrder: 1 },
      { id: "i3", folderId: null, name: "Bars", unitWeightMg: 68_000, qty: 5, classification: "consumable", sortOrder: 0 },
    ] as Item[]
  ).map(normalizeItem),
});

// ids are re-minted and sortOrder renumbered on import; everything else must survive
const strip = ({ id, folderId, sortOrder, ...rest }: Item) => rest;

describe("JSON round-trip", () => {
  it("export → import restores every item field (modulo ids and sort renumbering)", () => {
    const s = snap();
    const parsed = jsonToListImport(listToJson(s));
    expect(parsed).not.toBeNull();
    const { title, description, displayUnit, data } = parsed!;
    expect(title).toBe("Sierra loop");
    expect(description).toBe(s.description);
    expect(displayUnit).toBe("oz");

    expect(data.items).toHaveLength(s.items.length);
    for (const orig of s.items) {
      const got = data.items.find((i) => i.name === orig.name)!;
      expect(strip(got)).toEqual(strip(orig));
      expect(got.id).not.toBe(orig.id); // fresh ids — a backup's ids are foreign
    }

    // folder fields survive, ids are fresh, and membership follows the remap
    expect(data.folders.map((f) => [f.name, f.colorKey, f.defaultClassification, f.sortOrder])).toEqual([
      ["Shelter", "moss", "base", 0],
      ["On Body", "sky", "worn", 1],
    ]);
    expect(data.folders.map((f) => f.id)).not.toContain("f1");
    const shelter = data.folders.find((f) => f.name === "Shelter")!;
    expect(data.items.find((i) => i.name === "Duplex")!.folderId).toBe(shelter.id);
    expect(data.items.find((i) => i.name === "Socks")!.folderId).toBe(shelter.id);
    expect(data.items.find((i) => i.name === "Bars")!.folderId).toBeNull();
  });

  it("renumbers sortOrder per folder from the backup's ordering, even with gaps", () => {
    const s = snap();
    s.items.find((i) => i.name === "Duplex")!.sortOrder = 10;
    s.items.find((i) => i.name === "Socks")!.sortOrder = 3;
    const parsed = jsonToListImport(listToJson(s))!;
    const shelter = parsed.data.folders.find((f) => f.name === "Shelter")!;
    const inShelter = parsed.data.items.filter((i) => i.folderId === shelter.id);
    expect(inShelter.map((i) => [i.name, i.sortOrder])).toEqual([
      ["Socks", 0],
      ["Duplex", 1],
    ]);
  });
});

describe("jsonToListImport shape detection", () => {
  it("rejects non-JSON, non-object, and wrong-shape JSON", () => {
    expect(jsonToListImport("Category,Item Name\nShelter,Tarp")).toBeNull();
    expect(jsonToListImport("[1,2,3]")).toBeNull();
    expect(jsonToListImport('"a string"')).toBeNull();
    expect(jsonToListImport('{"title":"x"}')).toBeNull();
    expect(jsonToListImport('{"folders":[],"items":{}}')).toBeNull();
  });

  it("accepts a full API snapshot too (extra fields ignored)", () => {
    const parsed = jsonToListImport(JSON.stringify(snap()));
    expect(parsed?.data.items).toHaveLength(3);
  });

  it("treats blank meta as absent so the importer can fall back", () => {
    const parsed = jsonToListImport('{"title":"  ","displayUnit":"furlong","folders":[],"items":[]}')!;
    expect(parsed.title).toBeUndefined();
    expect(parsed.description).toBeUndefined();
    expect(parsed.displayUnit).toBeUndefined();
  });
});

describe("jsonToListImport sanitization", () => {
  it("clamps hostile values through the shared reducer helpers", () => {
    const parsed = jsonToListImport(
      JSON.stringify({
        title: "x".repeat(500),
        folders: [{ id: "f", name: "F", colorKey: "url(https://evil)", defaultClassification: "banana", sortOrder: 0 }],
        items: [{ id: "i", folderId: "f", name: "Anvil", unitWeightMg: 1e12, qty: 123456, classification: "banana", sortOrder: 0 }],
      }),
    )!;
    expect(parsed.title).toHaveLength(200);
    expect(parsed.data.folders[0]!.colorKey).toBe("other");
    expect(parsed.data.folders[0]!.defaultClassification).toBe("base");
    const anvil = parsed.data.items[0]!;
    expect(anvil.unitWeightMg).toBe(UNIT_WEIGHT_MAX_MG);
    expect(anvil.qty).toBe(9999);
    expect(anvil.classification).toBeNull();
  });

  it("re-mints duplicate ids and nulls dangling folder references", () => {
    const parsed = jsonToListImport(
      JSON.stringify({
        folders: [
          { id: "dup", name: "A", sortOrder: 0 },
          { id: "dup", name: "B", sortOrder: 1 },
        ],
        items: [
          { id: "same", folderId: "dup", name: "One", unitWeightMg: 0, qty: 1, classification: null, sortOrder: 0 },
          { id: "same", folderId: "ghost", name: "Two", unitWeightMg: 0, qty: 1, classification: null, sortOrder: 1 },
        ],
      }),
    )!;
    const [a, b] = parsed.data.folders;
    expect(a!.id).not.toBe(b!.id);
    const [one, two] = parsed.data.items;
    expect(one!.id).not.toBe(two!.id);
    // duplicate source folder id → first occurrence wins (mirrors addFolder's dedupe)
    expect(one!.folderId).toBe(a!.id);
    // "ghost" exists nowhere → unfiled, like addItem's dangling-folder coercion
    expect(two!.folderId).toBeNull();
  });

  it("caps folder and item counts at the reducer's hard limits", () => {
    const many = (n: number, mk: (i: number) => unknown) => Array.from({ length: n }, (_, i) => mk(i));
    const parsed = jsonToListImport(
      JSON.stringify({
        folders: many(MAX_FOLDERS + 5, (i) => ({ id: `f${i}`, name: `F${i}`, sortOrder: i })),
        items: many(MAX_ITEMS + 5, (i) => ({ id: `i${i}`, folderId: null, name: `I${i}`, unitWeightMg: 1, qty: 1, classification: null, sortOrder: i })),
      }),
    )!;
    expect(parsed.data.folders).toHaveLength(MAX_FOLDERS);
    expect(parsed.data.items).toHaveLength(MAX_ITEMS);
  });

  it("normalizes an all-worn split to the Worn class, like the reducer", () => {
    const parsed = jsonToListImport(
      JSON.stringify({
        folders: [],
        items: [{ id: "i", folderId: null, name: "Gloves", unitWeightMg: 1000, qty: 2, wornQty: 5, classification: null, sortOrder: 0 }],
      }),
    )!;
    const gloves = parsed.data.items[0]!;
    expect(gloves.classification).toBe("worn");
    expect(gloves.wornQty).toBeUndefined();
  });
});
