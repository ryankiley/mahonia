import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonToListImport, listToJson } from "../shared/exporters/json";
import { normalizeFolder } from "../shared/ops";
import { encodePolyline } from "../shared/polyline";
import type { ListData, ListSnapshot } from "../shared/types";
import { LISTS_DDL } from "../server/utils/db";
import { createList } from "../server/utils/listRepo";
import { createTestDb } from "./helpers/db";
import { dbState } from "./helpers/dbMock";

vi.mock("../server/utils/db", async (o) => (await import("./helpers/dbMock")).mockDbModule(o));

// A JSON backup is imported in two steps: jsonToListImport re-mints and renumbers it,
// and the create's normalizeListData / normalizeListMeta heal the whole list. The
// guarantees here belong to the pair, so each runs a file through both, as the import
// dialog does (the body crosses the wire as JSON), and reads what was stored.
async function importAndCreate(file: unknown): Promise<ListSnapshot> {
  const parsed = jsonToListImport(typeof file === "string" ? file : JSON.stringify(file));
  expect(parsed).not.toBeNull();
  const { snapshot } = await createList(JSON.parse(JSON.stringify(parsed)));
  return snapshot;
}

const backup = (patch: Record<string, unknown> = {}) => ({
  ...JSON.parse(
    listToJson({
      title: "Sierra loop",
      displayUnit: "oz",
      folders: [normalizeFolder({ id: "f1", name: "Shelter", colorKey: "moss", defaultClassification: "base", sortOrder: 0 })],
      items: [{ id: "i1", folderId: "f1", name: "Duplex", unitWeightMg: 538_000, qty: 1, classification: null, sortOrder: 0 }],
    }),
  ),
  ...patch,
});

beforeEach(async () => {
  dbState.db = await createTestDb(LISTS_DDL);
});

describe("importing a JSON backup, then creating the list", () => {
  it("stores a unit that is no unit as grams", async () => {
    const s = await importAndCreate('{"title":"  ","displayUnit":"furlong","folders":[],"items":[]}');
    expect(s.displayUnit).toBe("g");
  });

  it("starts a list that arrives with no name as Untitled list", async () => {
    const s = await importAndCreate(backup({ title: " \u2800 " }));
    expect(s.title).toBe("Untitled list");
  });

  it("cuts an over-long title to the cap", async () => {
    const s = await importAndCreate(backup({ title: "x".repeat(500) }));
    expect(s.title).toHaveLength(200);
  });

  it("drops a date that doesn't exist rather than storing it", async () => {
    const s = await importAndCreate(backup({ startDate: "2026-02-31", endDate: "2026-08-06" }));
    expect(s.startDate).toBeUndefined();
    expect(s.endDate).toBe("2026-08-06");
  });

  it("refuses a hand-edited profile that isn't one", async () => {
    // parseProfile is the single rule for what a profile is; junk must store as nothing
    // rather than render as terrain
    expect((await importAndCreate(backup({ trailProfile: "1000,not-a-number,1400" }))).trailProfile).toBeUndefined();
    expect((await importAndCreate(backup({ trailProfile: "1000,99999,1400" }))).trailProfile).toBeUndefined();
    expect((await importAndCreate(backup({ trailProfile: "1000,1200,1150" }))).trailProfile).toBe("1000,1200,1150");
  });

  // A pin is a distance along the route it was placed on. A route the create can't read
  // is dropped, and its pins go with it, as they do when a restore drops one: kept, they
  // sat in the list unseen (the plan draws pins only on a route) and went out again in
  // its backup and its copies.
  it("drops the pins of a route it can't read, and keeps the pins of one it can", async () => {
    const route = encodePolyline([
      { lat: 45.33, lon: -121.71 },
      { lat: 45.36, lon: -121.68 },
      { lat: 45.4, lon: -121.6 },
    ]);
    // the same points with the last value written one chunk longer than it needs
    const respelled = `${route.slice(0, -1)}${String.fromCharCode(route.charCodeAt(route.length - 1) + 0x20)}?`;
    const waypoints = [
      { id: "a", kind: "trailhead", alongM: 0 },
      { id: "b", kind: "water", alongM: 1_500, label: "Spring" },
      { id: "c", kind: "end", alongM: 9_000 },
    ];
    const pins = (s: ListSnapshot) => (s.waypoints ?? []).map((w) => `${w.kind}@${w.alongM}`);
    const all = ["trailhead@0", "water@1500", "end@9000"];

    const unread = await importAndCreate(backup({ routeGeometry: "??", waypoints }));
    expect(unread.routeGeometry).toBeUndefined();
    expect(pins(unread)).toEqual([]);

    const read = await importAndCreate(backup({ routeGeometry: route, waypoints }));
    expect(read.routeGeometry).toBe(route);
    expect(pins(read)).toEqual(all);
    // stored as this codec writes it, and still the same line
    const sameLine = await importAndCreate(backup({ routeGeometry: respelled, waypoints }));
    expect(sameLine.routeGeometry).toBe(route);
    expect(pins(sameLine)).toEqual(all);
    // a list can hold pins with no route at all
    expect(pins(await importAndCreate(backup({ waypoints })))).toEqual(all);
  });

  it("heals a hostile file", async () => {
    const s = await importAndCreate({
      title: "x".repeat(260) + "  Ryan's   list",
      description: "   ",
      displayUnit: "KG",
      trailUrl: "javascript:alert(1)",
      trailLabel: "  PCT  ",
      trailDistanceM: -5,
      startDate: "2026-0",
      endDate: "2026-07-04",
      routeGeometry: "??",
      folders: [
        { id: "f", name: "Shelter", sortOrder: 3 },
        { id: "f", name: "Dup folder id", sortOrder: 1 },
        null,
        { id: "k", name: "Kitchen", sortOrder: 2 },
        { id: "m", name: "Misc", sortOrder: 0 },
      ],
      people: [
        { id: "a", name: "Sam", sortOrder: 1 },
        { id: "b", name: "Sam", sortOrder: 0 },
        { id: "a", name: "Dup person id", sortOrder: 2 },
      ],
      items: [
        { id: "p", name: "parent", folderId: "f", sortOrder: 5, personId: "a" },
        { id: "c", name: "child", parentId: "p", folderId: "nope", sortOrder: 1, personId: "b" },
        { id: "c", name: "dup child id", sortOrder: 2, personId: "ghost" },
        { id: "g", name: "grandchild", parentId: "c", folderId: "k", sortOrder: 3 },
        { id: "s", name: "self", parentId: "s", folderId: "k", sortOrder: 0 },
        { id: "d", name: "dangling parent", parentId: "zzz", folderId: "k", sortOrder: 4 },
        { id: "t", name: "top in k", folderId: "k", sortOrder: 6 },
        "junk",
      ],
      days: [
        { id: "d1", label: "Day B", sortOrder: 1 },
        { id: "d1", label: "dup day", sortOrder: 0 },
      ],
    });

    expect(s.title).toBe("x".repeat(200));
    expect(s.displayUnit).toBe("g");
    expect(s.trailLabel).toBe("PCT");
    expect(s.endDate).toBe("2026-07-04");
    for (const k of ["description", "trailUrl", "trailDistanceM", "startDate", "routeGeometry"] as const) {
      expect(s[k], k).toBeUndefined();
    }

    // two rows that shared a source id are both kept; the grey folder is recoloured
    expect(s.folders.map((f) => [f.name, f.colorKey, f.sortOrder])).toEqual([
      ["Misc", "other", 0],
      ["Dup folder id", "shelter", 1],
      ["Kitchen", "kitchen", 2],
      ["Shelter", "sleep", 3],
    ]);
    // repeated names are numbered apart, not merged
    expect(s.people!.map((p) => [p.name, p.sortOrder])).toEqual([
      ["Sam", 0],
      ["Sam 2", 1],
      ["Dup person id", 2],
    ]);
    const name = (list: readonly { id: string; name: string }[], id: string | null | undefined) =>
      (id && list.find((r) => r.id === id)?.name) ?? null;
    // a self parent, a grandchild and a dangling parent all land top-level; a child rides
    // in its parent's folder; a dangling folder or person reads as none
    expect(
      s.items.map((i) => [i.name, name(s.folders, i.folderId), name(s.items, i.parentId), name(s.people!, i.personId), i.sortOrder]),
    ).toEqual([
      ["self", "Kitchen", null, null, 0],
      ["child", "Dup folder id", "parent", "Sam", 0],
      ["dup child id", null, null, null, 0],
      ["grandchild", "Kitchen", null, null, 0],
      ["dangling parent", "Kitchen", null, null, 1],
      ["parent", "Dup folder id", null, "Sam 2", 0],
      ["top in k", "Kitchen", null, null, 2],
    ]);
    expect(s.days!.map((d) => [d.label, d.sortOrder])).toEqual([
      ["dup day", 0],
      ["Day B", 1],
    ]);
  });
});

// The create route checks only that folders and items are arrays; what is IN them is
// whatever the request body said.
describe("createList with a body that isn't a backup", () => {
  it("drops rows that are not objects and keeps the rows beside them", async () => {
    const junk = [null, "tent", 7, ["nested"]];
    const { snapshot } = await createList({
      title: "Trip",
      data: {
        folders: [...junk, { id: "f1", name: "Shelter" }],
        items: [...junk, { id: "i1", name: "Tent", folderId: "f1", qty: 1 }],
        days: junk,
        waypoints: junk,
        people: junk,
      } as unknown as ListData,
    });
    expect(snapshot.folders.map((f) => f.id)).toEqual(["f1"]);
    expect(snapshot.items.map((i) => i.id)).toEqual(["i1"]);
    expect(snapshot.days).toEqual([]);
    expect(snapshot.waypoints).toEqual([]);
    expect(snapshot.people).toEqual([]);
  });

  // days, waypoints and people are not checked at all, so a body can send anything there
  it("reads days, waypoints or people that are not arrays as none", async () => {
    const { snapshot } = await createList({
      title: "Trip",
      data: {
        folders: [{ id: "f1", name: "Shelter" }],
        items: [{ id: "i1", name: "Tent", folderId: "f1", qty: 1 }],
        days: 5,
        waypoints: { id: "w1" },
        people: "Ryan",
      } as unknown as ListData,
    });
    expect(snapshot.items.map((i) => i.id)).toEqual(["i1"]);
    expect(snapshot.days).toEqual([]);
    expect(snapshot.waypoints).toEqual([]);
    expect(snapshot.people).toEqual([]);
  });
});
