// @vitest-environment nuxt
//
// THE SHARE VIEW'S half of the bare-group rule — the amount label and the class mark on
// a row with children that holds nothing of its own.
//
// It had no test at all: nothing in the suite mounted <ReadonlyItemRow>, so both of its
// changes could be reverted with 1,529 tests green. That matters more here than in the
// editor, because this is the view that can't heal anything it renders — whatever the
// row stores is what a reader sees — and the rule these two faces share is written on the
// promise that they "can't drift". A promise no test holds is a comment.
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ReadonlyItemRow from "~/components/ReadonlyItemRow.vue";
import type { Item, ListSnapshot } from "~~/shared/types";
import { blankList } from "./helpers/list";

const item = (over: Partial<Item> & { id: string }): Item => ({
  folderId: "f1",
  parentId: null,
  name: "",
  unitWeightMg: 0,
  qty: 1,
  classification: null,
  sortOrder: 0,
  ...over,
});

const CHILD = item({ id: "pot", name: "Pot", parentId: "kit", unitWeightMg: 100_000 });

let list: ListSnapshot;

function mountRow(row: Item, children: Item[] = []) {
  list = { ...blankList(), items: [row, ...children] } as ListSnapshot;
  return mount(ReadonlyItemRow, {
    props: { list, item: row, childrenByParent: new Map([[row.id, children]]) },
  });
}

// scoped to this row: a parent renders its children as more of the same component, so an
// unscoped find answers for the first CHILD — which carries every mark under test
const own = (w: ReturnType<typeof mountRow>) => w.find(".item-row");
const amount = (w: ReturnType<typeof mountRow>) => own(w).find(".item__roqty").text();
const hasMark = (w: ReturnType<typeof mountRow>) => own(w).find(".item__romark").exists();

describe("a bare group in the share view", () => {
  beforeEach(() => {
    list = blankList();
  });

  it("prints no count beside the group total", () => {
    const w = mountRow(item({ id: "kit", name: "Cook kit", qty: 4 }), [CHILD]);
    expect(amount(w)).toBe("");
    // the weight column is still the group's total, which is the figure a count there
    // would have been multiplying
    expect(own(w).find(".item__roweight").text()).toContain("100");
    w.unmount();
  });

  it("keeps the count on a group carrying a line of its own", () => {
    const w = mountRow(item({ id: "kit", name: "Cook kit", qty: 4, unitWeightMg: 210_000 }), [CHILD]);
    expect(amount(w)).toBe("×4");
    w.unmount();
  });

  // A class describes one row's own line, and a bare group's is zero — and its children
  // take the FOLDER's default, never their parent's. So the glyph would be a claim about
  // a total it doesn't govern.
  // A worn SPLIT is the one thing that draws a mark on a row carrying no class of its
  // own — and on a bare group it would be describing 1 of 3 units of a zero-weight row,
  // a claim about a total made entirely of children the split doesn't touch.
  it("draws no class mark on a bare group, split included", () => {
    const plain = mountRow(item({ id: "kit", name: "Cook kit", classification: null }), [CHILD]);
    expect(hasMark(plain)).toBe(false);
    plain.unmount();

    const split = mountRow(item({ id: "kit", name: "Cook kit", qty: 3, wornQty: 1 }), [CHILD]);
    expect(hasMark(split)).toBe(false);
    expect(amount(split)).toBe(""); // ...and no "×3 · 1 worn" beside the group total
    split.unmount();
  });

  // ...except where the owner set the class EXPLICITLY. Their editor still shows a
  // control for it and every export still writes it, so a reader who can't see it is the
  // only one out of the loop.
  it("keeps the mark on a group whose class was set explicitly", () => {
    const w = mountRow(item({ id: "kit", name: "Cook kit", classification: "consumable" }), [CHILD]);
    expect(hasMark(w)).toBe(true);
    w.unmount();
  });

  it("leaves a leaf alone", () => {
    const w = mountRow(item({ id: "pot", name: "Pot", qty: 3, unitWeightMg: 100_000 }));
    expect(amount(w)).toBe("×3");
    w.unmount();
  });
});
