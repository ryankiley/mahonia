import { describe, expect, it } from "vitest";
import { summarizeOps } from "../shared/changeSummary";
import type { Op } from "../shared/ops";

const item = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, folderId: null, name: id, unitWeightMg: 0, qty: 1, classification: null, sortOrder: 0, ...over }) as never;
const folder = (id: string, name: string) => ({ id, name, defaultClassification: "base", sortOrder: 0 }) as never;
/** The list as it stood before the batch — what lets the summary name things. */
const before = (items: unknown[] = [], folders: unknown[] = []) =>
  ({ items, folders }) as never;

describe("summarizeOps", () => {
  it("names the structural change first", () => {
    // an add carries the whole item, so it can name itself with no `before` at all
    expect(summarizeOps([{ t: "addItem", item: item("a") }] as Op[])).toBe("Added a");
    expect(summarizeOps([{ t: "addItem", item: item("a") }, { t: "addItem", item: item("b") }] as Op[]))
      .toBe("Added 2 items");
    expect(summarizeOps([{ t: "removeItem", id: "a" }, { t: "removeItem", id: "b" }] as Op[]))
      .toBe("Removed 2 items");
  });

  it("says both when a batch adds and removes", () => {
    expect(summarizeOps([{ t: "addItem", item: item("a") }, { t: "removeItem", id: "b" }] as Op[]))
      .toBe("Added 1, removed 1");
  });

  it("tells a rename from a re-weigh from a reclassify", () => {
    expect(summarizeOps([{ t: "updateItem", id: "a", patch: { name: "Tent" } }] as Op[]))
      .toBe("Renamed 1 item");
    // with the pre-edit list in hand it says which, and to what
    expect(summarizeOps(
      [{ t: "updateItem", id: "a", patch: { name: "Tent" } }] as Op[],
      before([item("a", { name: "Tarp" })]),
    )).toBe("Renamed Tarp → Tent");
    expect(summarizeOps([{ t: "updateItem", id: "a", patch: { unitWeightMg: 900 } }] as Op[]))
      .toBe("Changed 1 weight");
    expect(summarizeOps([{ t: "updateItem", id: "a", patch: { classification: "worn" } }] as Op[]))
      .toBe("Reclassified 1 item");
  });

  it("counts a unit change as a weight change — it re-expresses the same number", () => {
    expect(summarizeOps([{ t: "updateItem", id: "a", patch: { entryUnit: "oz" } }] as Op[]))
      .toBe("Changed 1 weight");
  });

  it("gives packing its own phrase rather than calling it an edit", () => {
    expect(summarizeOps([
      { t: "updateItem", id: "a", patch: { packed: true } },
      { t: "updateItem", id: "b", patch: { packed: true } },
    ] as Op[])).toBe("Checked off 2 items");
  });

  it("falls back to a COUNT for a genuine mixture, never to a bare 'Edited'", () => {
    const out = summarizeOps([
      { t: "updateItem", id: "a", patch: { name: "Tent" } },
      { t: "updateItem", id: "b", patch: { unitWeightMg: 900 } },
    ] as Op[]);
    expect(out).toBe("Edited 2 items");
  });

  it("returns empty for an empty batch, so the caller keeps its own default", () => {
    expect(summarizeOps([])).toBe("");
  });

  it("stays short enough to be a label", () => {
    const many = Array.from({ length: 999 }, (_, i) => ({ t: "addItem", item: item(`i${i}`) })) as Op[];
    expect(summarizeOps(many).length).toBeLessThan(40);
  });
});

describe("summarizeOps, with the list it is describing", () => {
  it("names a removal, which the op alone cannot", () => {
    expect(summarizeOps(
      [{ t: "removeItem", id: "a" }] as Op[],
      before([item("a", { name: "Nunatak quilt liner" })]),
    )).toBe("Removed Nunatak quilt liner");
  });

  it("says nothing about ops the editor performed on your behalf", () => {
    // a blank row tidying itself away, and a row being indented
    expect(summarizeOps([
      { t: "removeItem", id: "blank", quiet: true },
      { t: "moveItem", id: "a", folderId: null, sortOrder: 1, parentId: "b", quiet: true },
    ] as Op[], before([item("a"), item("blank", { name: "" })]))).toBe("");
  });

  it("ignores a rename that only tidies the spelling", () => {
    // the missing glyph in Arc'teryx, and a capitalisation fix — both fold equal
    expect(summarizeOps(
      [{ t: "updateItem", id: "a", patch: { brand: "Arc'teryx" } }] as Op[],
      before([item("a", { brand: "Arcteryx", name: "Cerium LT" })]),
    )).toBe("");
    expect(summarizeOps(
      [{ t: "updateItem", id: "a", patch: { name: "Durston X-Mid 2" } }] as Op[],
      before([item("a", { name: "durston x-mid 2" })]),
    )).toBe("");
  });

  it("tells a swapped piece of gear from a renamed one", () => {
    // a different catalog product — a fact in the patch, not a guess at similarity
    expect(summarizeOps(
      [{ t: "updateItem", id: "a", patch: { catalogItemId: 42, brand: "Big Agnes", name: "Copper Spur" } }] as Op[],
      before([item("a", { catalogItemId: 7, brand: "Durston", name: "X-Mid 2" })]),
    )).toBe("Swapped Durston X-Mid 2 for Big Agnes Copper Spur");
    // a size added to the same product is a refinement, and reads as one
    expect(summarizeOps(
      [{ t: "updateItem", id: "a", patch: { variant: "Olive" } }] as Op[],
      before([item("a", { brand: "Zpacks", name: "Duplex" })]),
    )).toBe("Renamed Zpacks Duplex → Zpacks Duplex Olive");
  });

  it("names the folder a real move went to", () => {
    expect(summarizeOps(
      [{ t: "moveItem", id: "a", folderId: "f", sortOrder: 0 }] as Op[],
      before([item("a", { name: "Sawyer Squeeze" })], [folder("f", "Water")]),
    )).toBe("Moved Sawyer Squeeze to Water");
  });

  it("counts rather than names once there is more than one", () => {
    expect(summarizeOps(
      [{ t: "removeItem", id: "a" }, { t: "removeItem", id: "b" }] as Op[],
      before([item("a", { name: "Tent" }), item("b", { name: "Stove" })]),
    )).toBe("Removed 2 items");
  });
});
