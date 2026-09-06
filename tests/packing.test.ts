// Packing-mode ticks (shared/packing): what a row's box stands for, which rows a tick
// on it writes, and which rows the progress count is over.
//
// Plain TS on purpose: every rule here is a pure function over items, and the mounted
// row's contract with them (the indeterminate property, the cascade through the
// reducer, the filter singleton) is itemPacking.nuxt.test.ts's job.
import { describe, expect, it } from "vitest";
import { childrenInView, countedForPacking, tickState, tickTargets } from "../shared/packing";
import { UNASSIGNED } from "../shared/people";
import type { Item } from "../shared/types";

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

const bag = item({ id: "bag", name: "Toiletry bag" });
const paste = item({ id: "paste", name: "Toothpaste", parentId: "bag" });
const brush = item({ id: "brush", name: "Toothbrush", parentId: "bag" });
const towel = item({ id: "towel", name: "Towel", parentId: "bag" });

describe("tickState: what a box shows", () => {
  it("is the row's own flag on a leaf", () => {
    expect(tickState(paste, [])).toBe("clear");
    expect(tickState({ ...paste, packed: true }, [])).toBe("checked");
  });

  it("is the children's on a group: none, some, all", () => {
    expect(tickState(bag, [paste, brush, towel])).toBe("clear");
    expect(tickState(bag, [{ ...paste, packed: true }, brush, towel])).toBe("mixed");
    expect(tickState(bag, [{ ...paste, packed: true }, { ...brush, packed: true }, towel])).toBe("mixed");
    expect(
      tickState(bag, [{ ...paste, packed: true }, { ...brush, packed: true }, { ...towel, packed: true }]),
    ).toBe("checked");
  });

  // The state in the report: a group ticked on its own, everything under it still
  // out. The group's flag is not a fact while it has children in view.
  it("ignores a group's own flag while it has children in view", () => {
    expect(tickState({ ...bag, packed: true }, [paste, brush])).toBe("clear");
    expect(tickState({ ...bag, packed: false }, [{ ...paste, packed: true }, { ...brush, packed: true }])).toBe(
      "checked",
    );
  });

  it("falls back to the group's own flag when nothing under it is in view", () => {
    expect(tickState({ ...bag, packed: true }, [])).toBe("checked");
  });
});

describe("childrenInView: which children the person filter keeps", () => {
  const group = item({ id: "tent", name: "Tent", personId: "sam" });
  const poles = item({ id: "poles", parentId: "tent" }); // inherits Sam
  const stakes = item({ id: "stakes", parentId: "tent", personId: "alex" });
  const kids = [poles, stakes];

  it("keeps every child in the everyone view", () => {
    expect(childrenInView(group, kids, null)).toBe(kids);
  });

  it("keeps a person's own rows and the ones inheriting the group's carrier", () => {
    expect(childrenInView(group, kids, "sam")).toEqual([poles]);
    expect(childrenInView(group, kids, "alex")).toEqual([stakes]);
  });

  it("keeps the unclaimed rows of an unclaimed group under Unassigned, and nothing under a claimed one", () => {
    expect(childrenInView(group, kids, UNASSIGNED)).toEqual([]);
    const loose = item({ id: "loose", name: "Loose" });
    const inherit = item({ id: "in", parentId: "loose" });
    const claimed = item({ id: "cl", parentId: "loose", personId: "sam" });
    expect(childrenInView(loose, [inherit, claimed], UNASSIGNED)).toEqual([inherit]);
  });
});

describe("tickTargets: what a tick writes", () => {
  it("writes the children of a group, never the group itself", () => {
    expect(tickTargets(bag, [paste, brush])).toEqual([paste, brush]);
  });

  it("writes the row itself on a leaf, or a group with nothing in view under it", () => {
    expect(tickTargets(paste, [])).toEqual([paste]);
    expect(tickTargets(bag, [])).toEqual([bag]);
  });
});

describe("countedForPacking: the rows the progress count is over", () => {
  it("counts leaves, not the group holding them", () => {
    expect(countedForPacking([bag, paste, brush, towel]).map((i) => i.id)).toEqual(["paste", "brush", "towel"]);
  });

  it("counts a group as its own line once none of its children are in the set", () => {
    // the strict person set: a group of Sam's whose every child is someone else's
    expect(countedForPacking([bag]).map((i) => i.id)).toEqual(["bag"]);
  });

  it("counts a child whose parent is outside the set", () => {
    // Sam's row under a group that isn't his: the row is his, the group is context
    expect(countedForPacking([paste]).map((i) => i.id)).toEqual(["paste"]);
  });
});
