// reconcileSnapshot patches a snapshot IN PLACE to equal another. The contract the
// editor leans on: after a call the target EQUALS the source, and every object the
// source didn't change is the very object the target already held — that identity is
// what keeps untouched rows from re-rendering when a flush or a poll adopts the
// server's copy. Checked both on plain objects and through a Vue reactive proxy,
// because the proxy is the caller.

import { describe, expect, it } from "vitest";
import { isReactive, reactive } from "vue";
import { reconcileSnapshot } from "../shared/reconcile";
import type { ListSnapshot } from "../shared/types";

const base = (): ListSnapshot => ({
  shareCode: "abc",
  slug: "trip",
  version: 3,
  isPublic: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  title: "Trip",
  description: "",
  displayUnit: "g",
  trailUrl: "https://example.com/route",
  folders: [
    { id: "f1", name: "Shelter", defaultClassification: "base", sortOrder: 0 },
    { id: "f2", name: "Kitchen", defaultClassification: "base", sortOrder: 1 },
  ],
  items: [
    { id: "i1", folderId: "f1", name: "Tent", unitWeightMg: 900_000, qty: 1, classification: null, sortOrder: 0 },
    { id: "i2", folderId: "f1", name: "Stakes", unitWeightMg: 50_000, qty: 1, classification: null, sortOrder: 1, parentId: "i1" },
    { id: "i3", folderId: "f2", name: "Stove", unitWeightMg: 80_000, qty: 1, classification: null, wornQty: undefined, sortOrder: 0 },
  ],
  people: [{ id: "p1", name: "Sam", sortOrder: 0 }],
});

// a deep copy with no shared objects, so identity claims below are real
const copy = (s: ListSnapshot): ListSnapshot => JSON.parse(JSON.stringify(s));

describe("reconcileSnapshot", () => {
  it("leaves an identical source untouched: same objects, nothing reassigned", () => {
    const target = base();
    const items = target.items;
    const tent = target.items[0];
    reconcileSnapshot(target, copy(target));
    expect(target).toEqual(copy(base()));
    expect(target.items).toBe(items);
    expect(target.items[0]).toBe(tent);
  });

  it("updates a changed row in place and keeps every untouched row's identity", () => {
    const target = base();
    const [tent, stakes, stove] = target.items;
    const source = copy(target);
    source.items[0]!.name = "Tent (new fly)";
    source.items[0]!.unitWeightMg = 850_000;
    source.version = 4;
    source.updatedAt = "2026-01-02T00:00:00.000Z";
    reconcileSnapshot(target, source);
    expect(target).toEqual(source);
    expect(target.items[0]).toBe(tent); // patched, not replaced
    expect(target.items[1]).toBe(stakes);
    expect(target.items[2]).toBe(stove);
    expect(target.items).not.toBe(source.items); // the array is the target's own
  });

  it("adds and removes rows, and reorders in place to the source's order", () => {
    const target = base();
    const items = target.items;
    const [tent, stakes, stove] = target.items;
    const source = copy(target);
    // drop the stove, add a pot, and put the pot before the tent
    source.items = [
      { id: "i9", folderId: "f2", name: "Pot", unitWeightMg: 120_000, qty: 1, classification: null, sortOrder: 1 },
      source.items[0]!,
      source.items[1]!,
    ];
    reconcileSnapshot(target, source);
    expect(target.items.map((i) => i.id)).toEqual(["i9", "i1", "i2"]);
    expect(target.items).toBe(items);
    expect(target.items[1]).toBe(tent);
    expect(target.items[2]).toBe(stakes);
    expect(target.items).not.toContain(stove);
    expect(target).toEqual(source);
  });

  it("moves rows the source reordered without touching their objects", () => {
    const target = base();
    const [tent, stakes, stove] = target.items;
    const source = copy(target);
    source.items = [source.items[2]!, source.items[1]!, source.items[0]!];
    reconcileSnapshot(target, source);
    expect(target.items).toEqual(source.items);
    expect(target.items[0]).toBe(stove);
    expect(target.items[1]).toBe(stakes);
    expect(target.items[2]).toBe(tent);
  });

  it("drops a field the source no longer carries, so a cleared value can't linger", () => {
    const target = base();
    const source = copy(target);
    delete source.trailUrl; // the reducer clears a link by deleting the key
    delete source.items[1]!.parentId; // an un-nested child
    reconcileSnapshot(target, source);
    expect("trailUrl" in target).toBe(false);
    expect("parentId" in target.items[1]!).toBe(false);
    expect(target).toEqual(source);
  });

  it("carries the meta over — version, updatedAt, and a nested value by value", () => {
    const target = base();
    const source = copy(target);
    source.version = 9;
    source.updatedAt = "2026-03-01T00:00:00.000Z";
    source.trailProfile = "10,20,30";
    source.routeGeometry = "_p~iF~ps|U";
    // no meta field is an object today; a nested value still has to replace, not merge
    (source as unknown as Record<string, unknown>).extra = { a: 1, b: [2] };
    reconcileSnapshot(target, source);
    expect(target.version).toBe(9);
    expect(target.updatedAt).toBe("2026-03-01T00:00:00.000Z");
    expect(target.trailProfile).toBe("10,20,30");
    expect(target.routeGeometry).toBe("_p~iF~ps|U");
    expect((target as unknown as Record<string, unknown>).extra).toEqual({ a: 1, b: [2] });
    expect(target).toEqual(source);
  });

  it("grows a list the target never had, and drains one the source dropped", () => {
    const target = base();
    const people = target.people!;
    const source = copy(target);
    source.days = [{ id: "d1", sortOrder: 0, distanceM: 12_000 }];
    delete source.people;
    reconcileSnapshot(target, source);
    expect(target.days).toEqual([{ id: "d1", sortOrder: 0, distanceM: 12_000 }]);
    expect(target.people).toBe(people); // the array survives, empty
    expect(target.people).toEqual([]);
  });

  it("writes through a reactive proxy: rows stay the same reactive objects", () => {
    const target = reactive(base()) as ListSnapshot;
    const tent = target.items[0]!;
    const source = copy(base());
    source.items[0]!.name = "Tent v2";
    source.items.push({ id: "i4", folderId: "f2", name: "Fuel", unitWeightMg: 100_000, qty: 1, classification: "consumable", sortOrder: 1 });
    source.days = [{ id: "d1", sortOrder: 0 }];
    reconcileSnapshot(target, source);
    expect(target.items[0]).toBe(tent);
    expect(tent.name).toBe("Tent v2");
    expect(isReactive(target.items[3])).toBe(true);
    expect(isReactive(target.days)).toBe(true); // created through the proxy, not raw
    expect(JSON.parse(JSON.stringify(target))).toEqual(source);
  });
});
