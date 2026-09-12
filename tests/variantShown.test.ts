import { describe, expect, it } from "vitest";
import { listToCsv } from "../shared/exporters/csv";
import { listToMarkdown } from "../shared/exporters/markdown";
import { variantShownIds } from "../shared/variantShown";
import type { Item, ListSnapshot } from "../shared/types";

// Which rows earn their variant beside the name: only a product the list holds in
// two variants, where the variant is the one thing telling the rows apart. The rule
// is a pure function of the items, so it is pinned here as plain TS; the three faces
// that render its answer (the checklist row, the share row, the editor's sub-line)
// are mounted in itemVariant.nuxt.test.ts.

const row = (id: string, over: Partial<Item> = {}): Item => ({
  id,
  folderId: "f1",
  parentId: null,
  name: "",
  unitWeightMg: 0,
  qty: 1,
  classification: null,
  sortOrder: 0,
  ...over,
});
const quilt = (id: string, variant?: string, over: Partial<Item> = {}) =>
  row(id, { brand: "Enlightened Equipment", name: "Revelation", variant, ...over });

const ids = (items: Item[]) => [...variantShownIds(items)].sort();

describe("variantShownIds", () => {
  it("shows no variant on a list that holds each product once", () => {
    expect(ids([quilt("q", "Long"), row("t", { brand: "Zpacks", name: "Duplex", variant: "Regular" })])).toEqual([]);
  });

  it("shows the variant on every row of a product the list holds in two variants", () => {
    expect(ids([quilt("a", "Long"), quilt("b", "Regular"), row("t", { name: "Tent" })])).toEqual(["a", "b"]);
  });

  it("…but not on two rows of the SAME variant, which the variant can't tell apart", () => {
    expect(ids([quilt("a", "Long"), quilt("b", "Long")])).toEqual([]);
  });

  it("a sized row beside an unsized twin still says its size", () => {
    // the unsized row has nothing to show; the sized one is the row a reader can't
    // otherwise tell from it
    expect(ids([quilt("sized", "Long"), quilt("plain")])).toEqual(["sized"]);
  });

  it("is per PRODUCT: the same model name under two brands is two products", () => {
    expect(
      ids([row("a", { brand: "Katabatic", name: "Flex", variant: "Long" }), row("b", { brand: "Hammock Gear", name: "Flex", variant: "Regular" })]),
    ).toEqual([]);
  });

  it("folds brand and name the way the vault does, so a typed twin matches a picked one", () => {
    expect(
      ids([row("a", { brand: "Zpacks", name: "Duplex", variant: "Long" }), row("b", { brand: "zpacks", name: " duplex ", variant: "Regular" })]),
    ).toEqual(["a", "b"]);
    // …and two spellings of one variant are one variant
    expect(ids([row("a", { brand: "Zpacks", name: "Duplex", variant: "Long" }), row("b", { brand: "Zpacks", name: "Duplex", variant: "long" })])).toEqual([]);
  });

  it("counts nested rows: the same quilt in two lengths inside one group", () => {
    expect(ids([row("g", { name: "Sleep kit" }), quilt("a", "Long", { parentId: "g" }), quilt("b", "Short", { parentId: "g" })])).toEqual(["a", "b"]);
  });

  it("skips nameless rows rather than treating their emptiness as a product", () => {
    expect(ids([row("x", { variant: "Long" }), row("y", { variant: "Short" }), row("z")])).toEqual([]);
  });
});

describe("the exports keep the variant regardless", () => {
  // a file is read without the context the row has, so a product held once still
  // names its size there — the rule above is about what a ROW shows
  const snap = (): ListSnapshot => ({
    shareCode: "X",
    slug: "x",
    version: 1,
    isPublic: false,
    title: "Trip",
    displayUnit: "g",
    folders: [{ id: "f1", name: "Sleep", defaultClassification: "base", sortOrder: 0 }],
    items: [quilt("q", "Long", { unitWeightMg: 560_000 })],
  });

  it("Markdown names the size of a product the list holds once", () => {
    expect(listToMarkdown(snap())).toContain("| Enlightened Equipment Revelation Long | 1 | 560 g |");
  });

  it("and so does the CSV", () => {
    expect(listToCsv(snap())).toContain("Revelation Long");
  });
});
