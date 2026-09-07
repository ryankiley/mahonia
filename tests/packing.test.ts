// Packing-mode ticks (shared/packing): what a row's box stands for, which rows a press
// on it writes, and which rows the progress count is over.
//
// The three are one rule, and these cases are mostly about holding them to it: whatever
// `tickState` classified, `tickRows` must write, and `countedForPacking` must count —
// disagree and the bar claims a number no box can reach, or a press lands somewhere the
// box wasn't reading.
//
// Plain TS on purpose: every rule here is a pure function over items, and the mounted
// row's contract with them (the indeterminate property, the cascade through the
// reducer, the filter singleton) is itemPacking.nuxt.test.ts's job.
import { describe, expect, it } from "vitest";
import { countedForPacking, tickRows, tickState } from "../shared/packing";
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

// a container: a group holding nothing of its own
const bag = item({ id: "bag", name: "Toiletry bag" });
const paste = item({ id: "paste", name: "Toothpaste", parentId: "bag" });
const brush = item({ id: "brush", name: "Toothbrush", parentId: "bag" });
const towel = item({ id: "towel", name: "Towel", parentId: "bag" });
const kids = [paste, brush, towel];
const ids = (rows: readonly Item[]) => rows.map((r) => r.id);

describe("tickState: what a box shows", () => {
  it("is the row's own flag on a leaf", () => {
    expect(tickState(paste, [], null)).toBe("clear");
    expect(tickState({ ...paste, packed: true }, [], null)).toBe("checked");
  });

  it("is the children's on a container: none, some, all", () => {
    expect(tickState(bag, kids, null)).toBe("clear");
    expect(tickState(bag, [{ ...paste, packed: true }, brush, towel], null)).toBe("mixed");
    expect(tickState(bag, [{ ...paste, packed: true }, { ...brush, packed: true }, towel], null)).toBe("mixed");
    expect(tickState(bag, kids.map((k) => ({ ...k, packed: true })), null)).toBe("checked");
  });

  // The state in the report: a container ticked on its own, everything under it still
  // out. Its own flag is not a fact while it is holding rows.
  it("ignores a container's own flag", () => {
    expect(tickState({ ...bag, packed: true }, kids, null)).toBe("clear");
    expect(
      tickState({ ...bag, packed: false }, kids.map((k) => ({ ...k, packed: true })), null),
    ).toBe("checked");
  });

  // A group carrying a weight or calories is real gear in its own right — the tent
  // body with its poles nested under it — so its line is one of the rows the box
  // stands for. isBareGroup is the app's existing predicate for exactly this.
  it("counts a carrying group's own line alongside its children", () => {
    for (const carrier of [
      item({ id: "tent", name: "Tent", unitWeightMg: 1_400_000 }),
      item({ id: "tent", name: "Dinners", kcal: 2400, classification: "consumable" }),
    ]) {
      const poles = item({ id: "poles", parentId: "tent", unitWeightMg: 400_000 });
      // the children are packed, the body is not — the box must not claim otherwise
      expect(tickState(carrier, [{ ...poles, packed: true }], null)).toBe("mixed");
      expect(tickState({ ...carrier, packed: true }, [{ ...poles, packed: true }], null)).toBe("checked");
      expect(tickState({ ...carrier, packed: true }, [poles], null)).toBe("mixed");
    }
  });
});

describe("under a person filter", () => {
  const group = item({ id: "tent", name: "Tent", personId: "sam" });
  const poles = item({ id: "poles", parentId: "tent" }); // inherits Sam
  const stakes = item({ id: "stakes", parentId: "tent", personId: "alex" });
  const both = [poles, stakes];

  it("counts a person's own rows and the ones inheriting the group's carrier", () => {
    expect(tickState(group, [{ ...poles, packed: true }, stakes], "sam")).toBe("checked");
    expect(tickState(group, [{ ...poles, packed: true }, stakes], null)).toBe("mixed");
    expect(tickState(group, [poles, { ...stakes, packed: true }], "alex")).toBe("checked");
  });

  it("writes only the children that view shows", () => {
    expect(ids(tickRows(group, both, "sam"))).toEqual(["poles"]);
    expect(ids(tickRows(group, both, "alex"))).toEqual(["stakes"]);
    expect(ids(tickRows(group, both, null))).toEqual(["poles", "stakes"]);
  });

  // THE REGRESSION. A container the filter leaves holding nothing stands for no row at
  // all. It must not fall back to its own flag: nothing draws that flag or counts it,
  // so the tick would vanish the moment the filter widened, and no box could clear it.
  it("stands for nothing — not for its own flag — when the filter hides every child", () => {
    const alexOnly = [
      item({ id: "poles", parentId: "tent", personId: "alex" }),
      item({ id: "stakes", parentId: "tent", personId: "alex" }),
    ];
    expect(tickState(group, alexOnly, "sam")).toBe("none");
    expect(tickRows(group, alexOnly, "sam")).toEqual([]);
    // ...and a flag an older build already wrote there is still not drawn
    expect(tickState({ ...group, packed: true }, alexOnly, "sam")).toBe("none");
  });

  // A group that carries its own line always has at least that to stand for, so it is
  // never "none" — and its tick survives the filter widening as a partial state.
  it("keeps a carrying group's own line when its children are hidden", () => {
    const tent = item({ id: "tent", name: "Tent", personId: "sam", unitWeightMg: 1_400_000 });
    const alexStakes = item({ id: "stakes", parentId: "tent", personId: "alex" });
    expect(tickState(tent, [alexStakes], "sam")).toBe("clear");
    expect(ids(tickRows(tent, [alexStakes], "sam"))).toEqual(["tent"]);
    expect(tickState({ ...tent, packed: true }, [alexStakes], "sam")).toBe("checked");
    expect(tickState({ ...tent, packed: true }, [alexStakes], null)).toBe("mixed");
  });

  it("keeps the unclaimed rows of an unclaimed container under Unassigned", () => {
    expect(tickRows(group, both, UNASSIGNED)).toEqual([]);
    const loose = item({ id: "loose", name: "Loose" });
    const inherit = item({ id: "in", parentId: "loose" });
    const claimed = item({ id: "cl", parentId: "loose", personId: "sam" });
    expect(ids(tickRows(loose, [inherit, claimed], UNASSIGNED))).toEqual(["in"]);
  });
});

describe("tickRows: what a press writes", () => {
  it("writes the children of a container, never the container itself", () => {
    expect(ids(tickRows(bag, kids, null))).toEqual(["paste", "brush", "towel"]);
  });

  it("writes the row itself on a leaf", () => {
    expect(ids(tickRows(paste, [], null))).toEqual(["paste"]);
  });

  it("writes a carrying group's own line with its children", () => {
    const tent = item({ id: "tent", name: "Tent", unitWeightMg: 1_400_000 });
    const poles = item({ id: "poles", parentId: "tent" });
    expect(ids(tickRows(tent, [poles], null))).toEqual(["tent", "poles"]);
  });

  // The pair has to agree in every case, or a press lands somewhere the box wasn't
  // reading. "none" is the only state that writes nothing.
  it("is empty exactly when tickState says none", () => {
    const cases: [Item, Item[], string | null][] = [
      [bag, kids, null],
      [bag, [], null],
      [paste, [], null],
      [item({ id: "tent", personId: "sam" }), [item({ id: "k", parentId: "tent", personId: "alex" })], "sam"],
      [item({ id: "tent", personId: "sam", unitWeightMg: 100 }), [item({ id: "k", parentId: "tent", personId: "alex" })], "sam"],
    ];
    for (const [row, children, selection] of cases) {
      expect(tickRows(row, children, selection).length === 0).toBe(
        tickState(row, children, selection) === "none",
      );
    }
  });
});

describe("countedForPacking: the rows the progress count is over", () => {
  it("counts what is in a container, not the container", () => {
    expect(countedForPacking([bag, ...kids]).map((i) => i.id)).toEqual(["paste", "brush", "towel"]);
  });

  it("counts a group that carries a line of its own", () => {
    const tent = item({ id: "tent", name: "Tent", unitWeightMg: 1_400_000 });
    const poles = item({ id: "poles", parentId: "tent" });
    expect(countedForPacking([tent, poles]).map((i) => i.id)).toEqual(["tent", "poles"]);
  });

  it("counts a childless row as its own line", () => {
    expect(countedForPacking([bag]).map((i) => i.id)).toEqual(["bag"]);
    expect(countedForPacking([paste]).map((i) => i.id)).toEqual(["paste"]);
  });

  // The filtered set alone can't tell a container from a leaf: under a person filter a
  // container whose children are all someone else's has no children in that set. Counted
  // off the whole list it stays a container, so the bar doesn't add a tick the filtered
  // view offers no box for — the "none" box above.
  it("decides what is a container from the whole list, not the filtered set", () => {
    const all = [bag, ...kids];
    expect(countedForPacking([bag], all)).toEqual([]);
    expect(countedForPacking([bag, paste], all).map((i) => i.id)).toEqual(["paste"]);
  });
});
