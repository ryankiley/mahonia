import { describe, expect, it } from "vitest";
import { applyOps, normalizeItem, type Op } from "../shared/ops";
import type { Item, ListState } from "../shared/types";

const base = (): ListState => ({
  title: "T",
  displayUnit: "g",
  folders: [
    { id: "f1", name: "Pack", defaultClassification: "base", sortOrder: 0 },
    { id: "f2", name: "Body", defaultClassification: "worn", sortOrder: 1 },
  ],
  items: [],
  version: 1,
});

describe("op reducer", () => {
  it("adds items, idempotent on duplicate id", () => {
    const s = base();
    const item = {
      id: "i1",
      folderId: "f1",
      name: "Tent",
      unitWeightMg: 538000,
      qty: 1,
      classification: null,
      sortOrder: 0,
    };
    applyOps(s, [{ t: "addItem", item } as Op, { t: "addItem", item } as Op]);
    expect(s.items.length).toBe(1);
    expect(s.items[0].name).toBe("Tent");
  });

  it("updates an item with a clamped patch", () => {
    const s = base();
    applyOps(s, [
      { t: "addItem", item: { id: "i1", folderId: "f1", name: "X", unitWeightMg: 0, qty: 1, classification: null, sortOrder: 0 } },
      { t: "updateItem", id: "i1", patch: { qty: -5, unitWeightMg: 12345.7, name: "Y" } },
    ]);
    expect(s.items[0].qty).toBe(0); // clamped to >= 0
    expect(s.items[0].unitWeightMg).toBe(12346); // rounded
    expect(s.items[0].name).toBe("Y");
  });

  it("catalogItemId: null unlinks (free rename → custom item); number re-links; absent leaves it", () => {
    const s = base();
    applyOps(s, [
      { t: "addItem", item: { id: "i1", folderId: "f1", name: "Multi Towel Lite", brand: "REI Co-op", variant: "Small", unitWeightMg: 21262, qty: 1, classification: null, sortOrder: 0, catalogItemId: 769, catalogWeightMgAtLink: 21262 } },
    ]);
    // an unrelated edit leaves the link untouched
    applyOps(s, [{ t: "updateItem", id: "i1", patch: { qty: 2 } }]);
    expect(s.items[0].catalogItemId).toBe(769);
    // free rename to a different product: the old link must NOT survive
    applyOps(s, [
      { t: "updateItem", id: "i1", patch: { name: "Matador Ultralight Travel Towel", brand: "", variant: "", catalogItemId: null, nameOverridden: true } },
    ]);
    expect(s.items[0].catalogItemId).toBeUndefined();
    expect(s.items[0].catalogWeightMgAtLink).toBeUndefined();
    expect(s.items[0].name).toBe("Matador Ultralight Travel Towel");
    // a null unlink also wins over a stray link-weight in the same patch
    applyOps(s, [{ t: "updateItem", id: "i1", patch: { catalogItemId: null, catalogWeightMgAtLink: 19000 } }]);
    expect(s.items[0].catalogWeightMgAtLink).toBeUndefined();
    // picking from autocomplete re-links
    applyOps(s, [
      { t: "updateItem", id: "i1", patch: { catalogItemId: 840, catalogWeightMgAtLink: 19000, unitWeightMg: 19000, nameOverridden: false } },
    ]);
    expect(s.items[0].catalogItemId).toBe(840);
    expect(s.items[0].catalogWeightMgAtLink).toBe(19000);
  });

  it("removes a folder and its items", () => {
    const s = base();
    applyOps(s, [
      { t: "addItem", item: { id: "i1", folderId: "f2", name: "Jacket", unitWeightMg: 300000, qty: 1, classification: null, sortOrder: 0 } },
      { t: "removeFolder", id: "f2" },
    ]);
    expect(s.folders.some((f) => f.id === "f2")).toBe(false);
    expect(s.items.length).toBe(0);
  });

  it("setMeta updates title + unit, ignores bad unit", () => {
    const s = base();
    applyOps(s, [{ t: "setMeta", patch: { title: "JMT", displayUnit: "oz" } }]);
    expect(s.title).toBe("JMT");
    expect(s.displayUnit).toBe("oz");
    applyOps(s, [{ t: "setMeta", patch: { displayUnit: "stone" as any } }]);
    expect(s.displayUnit).toBe("oz"); // unchanged
  });

  it("independent adds from two editors both land (merge)", () => {
    // simulate server applying editor A then editor B's op onto the same base
    const server = base();
    applyOps(server, [{ t: "addItem", item: { id: "a", folderId: "f1", name: "A", unitWeightMg: 1000, qty: 1, classification: null, sortOrder: 0 } }]);
    applyOps(server, [{ t: "addItem", item: { id: "b", folderId: "f1", name: "B", unitWeightMg: 2000, qty: 1, classification: null, sortOrder: 1 } }]);
    expect(server.items.map((i) => i.id).sort()).toEqual(["a", "b"]);
  });

  it("ignores malformed ops without throwing", () => {
    const s = base();
    expect(() => applyOps(s, [{} as Op, { t: "updateItem", id: "nope", patch: {} } as Op])).not.toThrow();
  });
});

describe("wornQty (the worn split on a base line)", () => {
  const add = (over: Record<string, unknown> = {}): Op => ({
    t: "addItem",
    item: { id: "i1", folderId: "f1", name: "Socks", unitWeightMg: 100000, qty: 3, classification: null, sortOrder: 0, ...over } as any,
  });

  it("stores a valid split; 0 / negative / NaN clear it", () => {
    const s = base();
    applyOps(s, [add(), { t: "updateItem", id: "i1", patch: { wornQty: 2 } }]);
    expect(s.items[0].wornQty).toBe(2);
    applyOps(s, [{ t: "updateItem", id: "i1", patch: { wornQty: 0 } }]);
    expect(s.items[0].wornQty).toBeUndefined();
    applyOps(s, [{ t: "updateItem", id: "i1", patch: { wornQty: 2 } }, { t: "updateItem", id: "i1", patch: { wornQty: -1 } }]);
    expect(s.items[0].wornQty).toBeUndefined();
    applyOps(s, [{ t: "updateItem", id: "i1", patch: { wornQty: NaN } }]);
    expect(s.items[0].wornQty).toBeUndefined();
  });

  it("re-clamps when qty drops, and reverts to base at qty < 2 (nothing to split)", () => {
    const s = base();
    applyOps(s, [add({ qty: 5 }), { t: "updateItem", id: "i1", patch: { wornQty: 3 } }]);
    applyOps(s, [{ t: "updateItem", id: "i1", patch: { qty: 4 } }]);
    expect(s.items[0].wornQty).toBe(3); // still a partial split at qty ≥ 2
    // qty 1 → the split is meaningless, so drop it and let base stand (not "1 worn · 0 base")
    applyOps(s, [{ t: "updateItem", id: "i1", patch: { qty: 1 } }]);
    expect(s.items[0].wornQty).toBeUndefined();
    // qty 0 likewise leaves no split
    applyOps(s, [{ t: "updateItem", id: "i1", patch: { qty: 3 } }, { t: "updateItem", id: "i1", patch: { wornQty: 2 } }]);
    expect(s.items[0].wornQty).toBe(2);
    applyOps(s, [{ t: "updateItem", id: "i1", patch: { qty: 0 } }]);
    expect(s.items[0].wornQty).toBeUndefined();
  });
  it("normalizeItem: a qty-1 item can't carry a split (reverts to base)", () => {
    const s = base();
    applyOps(s, [add({ qty: 1, wornQty: 1 })]);
    expect(s.items[0].wornQty).toBeUndefined();
  });
  it("collapses an all-worn split to the plain Worn class (no '0 base' remainder)", () => {
    const s = base();
    applyOps(s, [add({ qty: 3 }), { t: "updateItem", id: "i1", patch: { wornQty: 2 } }]); // 2 worn · 1 base
    expect(s.items[0].wornQty).toBe(2);
    // drop to qty 2 → every copy is now worn: becomes the Worn class, split cleared
    applyOps(s, [{ t: "updateItem", id: "i1", patch: { qty: 2 } }]);
    expect(s.items[0].wornQty).toBeUndefined();
    expect(s.items[0].classification).toBe("worn");
  });

  it("an explicit worn/consumable classification clears the split, even in the same patch", () => {
    const s = base();
    applyOps(s, [add(), { t: "updateItem", id: "i1", patch: { wornQty: 1 } }]);
    applyOps(s, [{ t: "updateItem", id: "i1", patch: { classification: "worn" } }]);
    expect(s.items[0].wornQty).toBeUndefined();
    applyOps(s, [{ t: "updateItem", id: "i1", patch: { classification: "consumable", wornQty: 2 } }]);
    expect(s.items[0].wornQty).toBeUndefined();
  });

  it("normalizes on addItem: over-count → Worn, partial kept, drops junk & worn/consumable carriers", () => {
    const s = base();
    applyOps(s, [add({ wornQty: 5 })]); // qty 3 default; every copy worn (over-count)
    expect(s.items[0].wornQty).toBeUndefined(); // → plain Worn class, not "3 worn · 0 base"
    expect(s.items[0].classification).toBe("worn");
    s.items = [];
    applyOps(s, [add({ wornQty: 1 })]); // a genuine partial split survives
    expect(s.items[0].wornQty).toBe(1);
    expect(s.items[0].classification).toBeNull();
    s.items = [];
    applyOps(s, [add({ wornQty: "2" })]);
    expect(s.items[0].wornQty).toBeUndefined(); // non-number dropped
    s.items = [];
    applyOps(s, [add({ wornQty: 1, classification: "worn" })]);
    expect(s.items[0].wornQty).toBeUndefined();
    s.items = [];
    applyOps(s, [add()]); // legacy shape: no wornQty
    expect(s.items[0].wornQty).toBeUndefined();
  });

  it("caps oversized item/folder id + folderId (single-row DoS guard)", () => {
    const s = base();
    const big = "z".repeat(500);
    applyOps(s, [
      { t: "addFolder", folder: { id: big, name: "F", defaultClassification: "base", sortOrder: 0 } as any },
      { t: "addItem", item: { id: big, folderId: big, name: "I", unitWeightMg: 0, qty: 1, classification: null, sortOrder: 0 } as any },
    ]);
    const folder = s.folders[s.folders.length - 1]!;
    const item = s.items[s.items.length - 1]!;
    expect(folder.id.length).toBe(128);
    expect(item.id.length).toBe(128);
    expect(item.folderId!.length).toBe(128); // still resolves to the (capped) folder, not nulled
    // a normal-length id is untouched
    s.items = [];
    applyOps(s, [{ t: "addItem", item: { id: "i-ok", folderId: "f1", name: "J", unitWeightMg: 0, qty: 1, classification: null, sortOrder: 0 } }]);
    expect(s.items[0]!.id).toBe("i-ok");
  });

  it("rejects an unsafe folder colorKey (CSS-injection guard)", () => {
    const s = base();
    applyOps(s, [
      { t: "addFolder", folder: { id: "fc", name: "C", colorKey: "x,url(//evil.tld)", defaultClassification: "base", sortOrder: 0 } as any },
    ]);
    const fc = () => s.folders.find((x) => x.id === "fc")!;
    expect(fc().colorKey).toBe("other"); // unsafe key dropped to the neutral default
    applyOps(s, [{ t: "updateFolder", id: "fc", patch: { colorKey: "h240" } }]);
    expect(fc().colorKey).toBe("h240"); // valid key accepted
    applyOps(s, [{ t: "updateFolder", id: "fc", patch: { colorKey: "evil;}" } }]);
    expect(fc().colorKey).toBe("h240"); // unsafe patch ignored, prior value kept
  });

  it("sets a folder sortBy, clears it on Manual, and rejects unknown values", () => {
    const s = base();
    const f1 = () => s.folders.find((x) => x.id === "f1")!;
    // a new folder has no stored sort (Manual is the absent default)
    expect(f1().sortBy).toBeUndefined();
    // a known non-default sort is accepted
    applyOps(s, [{ t: "updateFolder", id: "f1", patch: { sortBy: "heaviest" } }]);
    expect(f1().sortBy).toBe("heaviest");
    // switching back to Manual clears the field (not persisted as "manual")
    applyOps(s, [{ t: "updateFolder", id: "f1", patch: { sortBy: "manual" } }]);
    expect(f1().sortBy).toBeUndefined();
    // an unknown value also clears it (defensive: never persist garbage)
    applyOps(s, [{ t: "updateFolder", id: "f1", patch: { sortBy: "name" } }]);
    applyOps(s, [{ t: "updateFolder", id: "f1", patch: { sortBy: "sideways" as any } }]);
    expect(f1().sortBy).toBeUndefined();
  });

  it("normalizes a folder's sortBy on add (valid kept, invalid dropped)", () => {
    const s = base();
    applyOps(s, [
      { t: "addFolder", folder: { id: "fa", name: "A", defaultClassification: "base", sortBy: "name", sortOrder: 2 } as any },
      { t: "addFolder", folder: { id: "fb", name: "B", defaultClassification: "base", sortBy: "bogus", sortOrder: 3 } as any },
    ]);
    expect(s.folders.find((f) => f.id === "fa")!.sortBy).toBe("name");
    expect(s.folders.find((f) => f.id === "fb")!.sortBy).toBeUndefined();
  });
});

describe("nesting (parentId)", () => {
  const parent = (id: string, over: Record<string, unknown> = {}): Op => ({
    t: "addItem",
    item: { id, folderId: "f1", name: id, unitWeightMg: 0, qty: 1, classification: null, sortOrder: 0, ...over } as any,
  });
  const childOf = (id: string, parentId: string, over: Record<string, unknown> = {}): Op => ({
    t: "addItem",
    item: { id, folderId: "f1", parentId, name: id, unitWeightMg: 100, qty: 1, classification: null, sortOrder: 0, ...over } as any,
  });

  it("addItem with a valid parent nests it (and inherits the parent's folder)", () => {
    const s = base();
    applyOps(s, [parent("tent"), childOf("fly", "tent", { folderId: "f2" })]);
    const fly = s.items.find((i) => i.id === "fly")!;
    expect(fly.parentId).toBe("tent");
    expect(fly.folderId).toBe("f1"); // follows the parent's folder, not the op's f2
  });

  it("addItem with a dangling / self parent coerces to top-level", () => {
    const s = base();
    applyOps(s, [parent("tent"), childOf("ghost", "nope"), { t: "addItem", item: { id: "self", folderId: "f1", parentId: "self", name: "x", unitWeightMg: 0, qty: 1, classification: null, sortOrder: 0 } as any }]);
    expect(s.items.find((i) => i.id === "ghost")!.parentId).toBeNull();
    expect(s.items.find((i) => i.id === "self")!.parentId).toBeNull();
  });

  it("moveItem reparents; nesting is one level (can't nest under a child, or nest a parent)", () => {
    const s = base();
    applyOps(s, [parent("tent"), childOf("fly", "tent"), parent("pack", { sortOrder: 1 })]);
    // nest pack under tent
    applyOps(s, [{ t: "moveItem", id: "pack", folderId: "f1", parentId: "tent", sortOrder: 1 }]);
    expect(s.items.find((i) => i.id === "pack")!.parentId).toBe("tent");
    // can't nest under a CHILD (fly) — stays top-level (parentId cleared)
    applyOps(s, [parent("bag", { sortOrder: 2 }), { t: "moveItem", id: "bag", folderId: "f1", parentId: "fly", sortOrder: 0 }]);
    expect(s.items.find((i) => i.id === "bag")!.parentId).toBeNull();
    // tent HAS children, so it can't itself be nested under pack — stays top-level
    applyOps(s, [{ t: "moveItem", id: "tent", folderId: "f1", parentId: "pack", sortOrder: 0 }]);
    expect(s.items.find((i) => i.id === "tent")!.parentId).toBeNull();
  });

  it("moveItem with no parentId is a plain reorder — nesting is left unchanged", () => {
    const s = base();
    applyOps(s, [parent("tent"), childOf("fly", "tent")]);
    applyOps(s, [{ t: "moveItem", id: "fly", folderId: "f1", sortOrder: 5 }]);
    const fly = s.items.find((i) => i.id === "fly")!;
    expect(fly.parentId).toBe("tent"); // still nested
    expect(fly.sortOrder).toBe(5);
  });

  it("removeItem cascades to the item's nested children", () => {
    const s = base();
    applyOps(s, [parent("tent"), childOf("fly", "tent"), childOf("inner", "tent"), parent("pack", { sortOrder: 1 })]);
    applyOps(s, [{ t: "removeItem", id: "tent" }]);
    expect(s.items.map((i) => i.id)).toEqual(["pack"]); // tent + both children gone
  });

  it("removeFolder takes nested children with it (they carry the parent's folderId)", () => {
    const s = base();
    applyOps(s, [parent("tent"), childOf("fly", "tent")]);
    applyOps(s, [{ t: "removeFolder", id: "f1" }]);
    expect(s.items).toEqual([]);
  });

  it("normalizeItem clamps parentId to a string or null", () => {
    expect(normalizeItem({ id: "a", parentId: "p" } as unknown as Item).parentId).toBe("p");
    expect(normalizeItem({ id: "a" } as unknown as Item).parentId).toBeNull();
    expect(normalizeItem({ id: "a", parentId: 42 } as unknown as Item).parentId).toBeNull();
  });
});

