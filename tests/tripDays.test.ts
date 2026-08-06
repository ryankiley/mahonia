import { describe, expect, it } from "vitest";
import { applyOps, MAX_DAYS, normalizeDay, type Op } from "../shared/ops";
import { applyListDiff, diffListState, fullSnapToState, stateToFullSnap } from "../shared/snapshotDiff";
import { cloneListData } from "../shared/clone";
import { jsonToListImport, listToJson } from "../shared/exporters/json";
import { summarizeOps } from "../shared/changeSummary";
import type { ListState, TripDay } from "../shared/types";

const state = (over: Partial<ListState> = {}): ListState => ({
  title: "Trip",
  displayUnit: "g",
  folders: [],
  items: [],
  days: [],
  version: 1,
  ...over,
});

const day = (over: Partial<TripDay> = {}): TripDay => ({ id: "d1", sortOrder: 0, ...over });

describe("day ops", () => {
  it("adds, updates and removes", () => {
    const s = state();
    applyOps(s, [{ t: "addDay", day: day({ id: "a", label: "Over the pass", distanceM: 14_200 }) }]);
    expect(s.days).toHaveLength(1);
    expect(s.days![0]).toMatchObject({ id: "a", label: "Over the pass", distanceM: 14_200 });

    applyOps(s, [{ t: "updateDay", id: "a", patch: { ascentM: 840 } }]);
    expect(s.days![0]!.ascentM).toBe(840);

    applyOps(s, [{ t: "removeDay", id: "a" }]);
    expect(s.days).toHaveLength(0);
  });

  it("refuses a duplicate id, like addFolder does", () => {
    const s = state();
    applyOps(s, [
      { t: "addDay", day: day({ id: "a", distanceM: 1000 }) },
      { t: "addDay", day: day({ id: "a", distanceM: 9999 }) },
    ]);
    expect(s.days).toHaveLength(1);
    expect(s.days![0]!.distanceM).toBe(1000);
  });

  it("caps the itinerary", () => {
    const s = state();
    const ops: Op[] = Array.from({ length: MAX_DAYS + 10 }, (_, i) => ({
      t: "addDay",
      day: day({ id: `d${i}`, sortOrder: i }),
    }));
    applyOps(s, ops);
    expect(s.days).toHaveLength(MAX_DAYS);
  });

  it("ignores an op for a day that isn't there, rather than throwing", () => {
    const s = state();
    applyOps(s, [{ t: "updateDay", id: "nope", patch: { distanceM: 5000 } }]);
    expect(s.days).toHaveLength(0);
  });

  it("removing a day touches nothing else — gear belongs to the trip, not to a Tuesday", () => {
    const s = state({
      items: [{ id: "i1", folderId: null, name: "Tent", qty: 1, unitWeightMg: 1000, classification: null, sortOrder: 0 }],
      days: [day({ id: "a" })],
    });
    applyOps(s, [{ t: "removeDay", id: "a" }]);
    expect(s.items).toHaveLength(1);
  });

  it("works on a state that predates days entirely", () => {
    // the shape every existing row has: no `days` key at all
    const s = { title: "T", displayUnit: "g", folders: [], items: [], version: 1 } as unknown as ListState;
    applyOps(s, [{ t: "addDay", day: day({ id: "a" }) }]);
    expect(s.days).toHaveLength(1);
  });
});

describe("normalizeDay", () => {
  it("keeps usable metres and drops the rest", () => {
    expect(normalizeDay(day({ distanceM: 14_200.4, ascentM: 840 }))).toMatchObject({
      distanceM: 14_200,
      ascentM: 840,
    });
  });

  it("clears a zero rather than storing a claim", () => {
    // a zero would read as "this day covers no ground"; absent reads as "not filled in"
    const d = normalizeDay(day({ distanceM: 0, ascentM: 0 }));
    expect(d.distanceM).toBeUndefined();
    expect(d.ascentM).toBeUndefined();
  });

  it("declines nonsense and absurd values", () => {
    expect(normalizeDay(day({ distanceM: -5 })).distanceM).toBeUndefined();
    expect(normalizeDay(day({ distanceM: 1e9 })).distanceM).toBeUndefined();
    expect(normalizeDay(day({ ascentM: 99_999 })).ascentM).toBeUndefined();
    expect(normalizeDay(day({ distanceM: Number.NaN })).distanceM).toBeUndefined();
  });

  it("keeps `rest` only when it's literally true", () => {
    expect(normalizeDay(day({ rest: true })).rest).toBe(true);
    expect(normalizeDay(day({ rest: false as unknown as true })).rest).toBeUndefined();
  });

  it("a rest day is expressible, where a zero distance is not", () => {
    const d = normalizeDay(day({ rest: true, distanceM: 0 }));
    expect(d.rest).toBe(true);
    expect(d.distanceM).toBeUndefined();
  });
});

describe("day patches clear as well as set", () => {
  it("an explicit undefined erases a value", () => {
    const s = state({ days: [day({ id: "a", distanceM: 14_000, ascentM: 800 })] });
    applyOps(s, [{ t: "updateDay", id: "a", patch: { ascentM: undefined } }]);
    expect(s.days![0]!.distanceM).toBe(14_000);
    expect(s.days![0]!.ascentM).toBeUndefined();
  });

  it("turning a rest day back into a walking day clears the flag", () => {
    const s = state({ days: [day({ id: "a", rest: true })] });
    applyOps(s, [{ t: "updateDay", id: "a", patch: { rest: false as unknown as true } }]);
    expect(s.days![0]!.rest).toBeUndefined();
  });
});

describe("round trips", () => {
  const withDays = state({
    days: [day({ id: "a", sortOrder: 0, label: "In", distanceM: 14_200, ascentM: 840 }), day({ id: "b", sortOrder: 1, rest: true })],
  });

  it("survives a recovery snapshot", () => {
    const back = fullSnapToState(stateToFullSnap(withDays));
    expect(back.days).toHaveLength(2);
    expect(back.days![0]).toMatchObject({ label: "In", distanceM: 14_200 });
    expect(back.days![1]!.rest).toBe(true);
  });

  it("survives a snapshot DIFF, including a delete", () => {
    const target = state({ days: [day({ id: "a", distanceM: 20_000 }), day({ id: "c", label: "New" })] });
    const restored = applyListDiff(withDays, diffListState(withDays, target));
    const ids = restored.days!.map((d) => d.id).sort();
    expect(ids).toEqual(["a", "c"]);
    expect(restored.days!.find((d) => d.id === "a")!.distanceM).toBe(20_000);
  });

  it("diffs against a base that predates days without throwing", () => {
    const old = { title: "T", displayUnit: "g", folders: [], items: [], version: 1 } as unknown as ListState;
    const diff = diffListState(old, withDays);
    expect(diff.daysUpsert).toHaveLength(2);
    expect(applyListDiff(old, diff).days).toHaveLength(2);
  });

  it("survives a JSON backup", () => {
    const parsed = jsonToListImport(listToJson({ ...withDays, description: undefined }))!;
    expect(parsed.data.days).toHaveLength(2);
    expect(parsed.data.days![0]).toMatchObject({ label: "In", distanceM: 14_200, sortOrder: 0 });
    // ids are re-minted, like folders and items
    expect(parsed.data.days![0]!.id).not.toBe("a");
  });

  it("imports a backup written before days existed", () => {
    const legacy = JSON.stringify({ title: "T", displayUnit: "g", folders: [], items: [] });
    expect(jsonToListImport(legacy)!.data.days).toEqual([]);
  });

  it("comes along when a list is duplicated, with fresh ids", () => {
    const copy = cloneListData(withDays);
    expect(copy.days).toHaveLength(2);
    expect(copy.days[0]!.id).not.toBe("a");
    expect(copy.days[0]!.label).toBe("In");
  });
});

describe("change summary", () => {
  const ctx = { folders: [], items: [] };
  it("names days the way it names folders", () => {
    expect(summarizeOps([{ t: "addDay", day: day({ id: "a" }) }], ctx)).toBe("Added 1 day");
    expect(
      summarizeOps([{ t: "addDay", day: day({ id: "a" }) }, { t: "addDay", day: day({ id: "b" }) }], ctx),
    ).toBe("Added 2 days");
    expect(summarizeOps([{ t: "removeDay", id: "a" }], ctx)).toBe("Removed 1 day");
    expect(summarizeOps([{ t: "updateDay", id: "a", patch: { distanceM: 1000 } }], ctx)).toBe("Edited 1 day");
  });
});
