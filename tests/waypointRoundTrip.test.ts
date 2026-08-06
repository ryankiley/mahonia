import { describe, expect, it } from "vitest";
import { applyOps, MAX_WAYPOINTS, normalizeWaypoint, type Op } from "../shared/ops";
import { applyListDiff, diffListState, fullSnapToState, stateToFullSnap } from "../shared/snapshotDiff";
import { cloneListData } from "../shared/clone";
import { jsonToListImport, listToJson } from "../shared/exporters/json";
import { summarizeOps } from "../shared/changeSummary";
import { encodePolyline } from "../shared/polyline";
import type { ListState, Waypoint } from "../shared/types";

// THIS TEST IS THE CHECKLIST.
//
// Adding a field to a list-shaped thing is never one edit — it is a dozen, and a field
// carried by some paths and not others doesn't error. It silently disappears at whichever
// boundary was missed. That has happened FOUR times on this branch alone: createList
// dropped a draft's profile, the snapshot chain dropped the route and NULLed it on
// restore, the JSON exporter wrote a profile the importer never read back, and three owner
// paths forgot the wrapper that re-attaches an owner-only field.
//
// Every one of those was invisible until someone traced the field by hand. So rather than
// trusting a checklist in a plan document, this walks a waypoint and a route geometry
// through every pure boundary in the chain and asserts they survive each one. A path that
// forgets them fails HERE, loudly, instead of in a year when somebody restores a backup.

const GEOMETRY = encodePolyline([
  { lat: 45.33, lon: -121.71 },
  { lat: 45.34, lon: -121.7 },
  { lat: 45.35, lon: -121.69 },
]);

const WAYPOINTS: Waypoint[] = [
  { id: "w1", kind: "trailhead", alongM: 0, label: "Timberline Lodge" },
  { id: "w2", kind: "water", alongM: 6_200, label: "spring", note: "40 m off trail, left" },
  { id: "w3", kind: "camp", alongM: 16_100, label: "Cairn Basin" },
];

const state = (over: Partial<ListState> = {}): ListState => ({
  title: "Timberline",
  description: "",
  displayUnit: "g",
  folders: [],
  items: [],
  days: [],
  waypoints: [],
  version: 0,
  ...over,
});

const withRoute = () => state({ waypoints: [...WAYPOINTS], routeGeometry: GEOMETRY });

describe("a waypoint survives every boundary in the chain", () => {
  it("the REDUCER — three ops, client and server alike", () => {
    const ops: Op[] = WAYPOINTS.map((w) => ({ t: "addWaypoint", waypoint: w }));
    const s = applyOps(state(), ops);
    expect(s.waypoints).toHaveLength(3);

    const moved = applyOps(s, [{ t: "updateWaypoint", id: "w2", patch: { alongM: 7_000 } }]);
    expect(moved.waypoints!.find((w) => w.id === "w2")!.alongM).toBe(7_000);

    const gone = applyOps(moved, [{ t: "removeWaypoint", id: "w2" }]);
    expect(gone.waypoints!.map((w) => w.id)).toEqual(["w1", "w3"]);
  });

  it("the SNAPSHOT CHAIN — the boundary that NULLed the route last time", () => {
    const back = fullSnapToState(stateToFullSnap(withRoute()));
    expect(back.routeGeometry).toBe(GEOMETRY);
    expect(back.waypoints).toHaveLength(3);
    expect(back.waypoints!.find((w) => w.id === "w2")!.note).toBe("40 m off trail, left");
  });

  it("the DIFF — records both an addition and a removal", () => {
    const added = diffListState(state(), withRoute());
    expect(added.meta?.routeGeometry).toBe(GEOMETRY);
    expect(added.waypointsUpsert).toHaveLength(3);
    expect(applyListDiff(state(), added).waypoints).toHaveLength(3);

    const cleared = diffListState(withRoute(), state());
    expect(cleared.meta?.routeGeometry).toBe(""); // the falsy clear sentinel
    expect(cleared.waypointsDel).toHaveLength(3);
    const out = applyListDiff(withRoute(), cleared);
    expect("routeGeometry" in out).toBe(false);
    expect(out.waypoints).toEqual([]);
  });

  it("the JSON BACKUP — both directions, which is where the last one broke", () => {
    const json = listToJson(withRoute() as never);
    expect(json).toContain("routeGeometry");
    const back = jsonToListImport(json)!;
    expect(back.routeGeometry).toBe(GEOMETRY);
    expect(back.data.waypoints).toHaveLength(3);
    // ids are re-minted, like every other entity a backup carries
    expect(back.data.waypoints!.map((w) => w.id)).not.toEqual(WAYPOINTS.map((w) => w.id));
    expect(back.data.waypoints!.map((w) => w.label)).toEqual(["Timberline Lodge", "spring", "Cairn Basin"]);
  });

  it("a DUPLICATE — fresh ids, same positions", () => {
    const copy = cloneListData(withRoute() as never);
    expect(copy.waypoints).toHaveLength(3);
    expect(copy.waypoints.map((w) => w.id)).not.toEqual(WAYPOINTS.map((w) => w.id));
    expect(copy.waypoints.map((w) => w.alongM)).toEqual([0, 6_200, 16_100]);
  });

  it("the CHANGE SUMMARY — a recovery point says what it holds", () => {
    expect(summarizeOps([{ t: "addWaypoint", waypoint: WAYPOINTS[0]! }])).toMatch(/waypoint/i);
    expect(summarizeOps([{ t: "removeWaypoint", id: "w1" }])).toMatch(/waypoint/i);
  });

  it("END TO END — ops, snapshot, diff, backup, and back to a list", () => {
    // the whole chain in one pass; a break anywhere shows up as a count that isn't 3
    const live = applyOps(
      state({ routeGeometry: GEOMETRY }),
      WAYPOINTS.map((w) => ({ t: "addWaypoint", waypoint: w }) as Op),
    );
    const restored = applyListDiff(state(), diffListState(state(), live));
    const throughSnapshot = fullSnapToState(stateToFullSnap(restored));
    const reimported = jsonToListImport(listToJson(throughSnapshot as never))!;
    expect(reimported.routeGeometry).toBe(GEOMETRY);
    expect(reimported.data.waypoints).toHaveLength(3);
    expect(reimported.data.waypoints!.map((w) => w.kind)).toEqual(["trailhead", "water", "camp"]);
  });
});

describe("what the reducer refuses", () => {
  it("a pin with no position on the route is not a pin", () => {
    // unlike a day, where every field is optional because a half-filled itinerary is
    // normal, a waypoint without an alongM is not partially placed — it isn't placed
    expect(normalizeWaypoint({ id: "x", kind: "water" } as Waypoint)).toBeNull();
    expect(normalizeWaypoint({ id: "x", kind: "water", alongM: -5 } as Waypoint)).toBeNull();
    expect(normalizeWaypoint({ id: "", kind: "water", alongM: 10 } as Waypoint)).toBeNull();
  });

  it("an unknown kind becomes the neutral one rather than being dropped", () => {
    const w = normalizeWaypoint({ id: "x", kind: "helipad" as never, alongM: 10 });
    expect(w!.kind).toBe("landmark");
  });

  it("caps the count, and refuses a duplicate id", () => {
    const many: Op[] = Array.from({ length: MAX_WAYPOINTS + 20 }, (_, i) => ({
      t: "addWaypoint",
      waypoint: { id: `w${i}`, kind: "landmark", alongM: i * 10 },
    }));
    expect(applyOps(state(), many).waypoints).toHaveLength(MAX_WAYPOINTS);

    const dupe = applyOps(state(), [
      { t: "addWaypoint", waypoint: { id: "same", kind: "water", alongM: 10 } },
      { t: "addWaypoint", waypoint: { id: "same", kind: "camp", alongM: 20 } },
    ]);
    expect(dupe.waypoints).toHaveLength(1);
    expect(dupe.waypoints![0]!.kind).toBe("water"); // first occurrence wins, like addItem
  });

  it("a patch can MOVE a pin but never un-place it", () => {
    const s = applyOps(state(), [
      { t: "addWaypoint", waypoint: { id: "w", kind: "water", alongM: 500 } },
    ]);
    const bad = applyOps(s, [{ t: "updateWaypoint", id: "w", patch: { alongM: -1 } }]);
    expect(bad.waypoints![0]!.alongM).toBe(500);
  });

  it("clears a label through the patch, because `in` beats truthiness", () => {
    const s = applyOps(state(), [
      { t: "addWaypoint", waypoint: { id: "w", kind: "water", alongM: 5, label: "spring" } },
    ]);
    const cleared = applyOps(s, [{ t: "updateWaypoint", id: "w", patch: { label: "" } }]);
    expect(cleared.waypoints![0]!.label).toBeUndefined();
  });
});
