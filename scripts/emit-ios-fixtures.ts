// Golden-fixture emitter for the native iOS port's conformance suite.
//
// The iOS app (github.com/ryankiley/mahonia-ios) carries a Swift port of the
// shared/ op-reducer, and two implementations of one reducer WILL drift
// silently — so this script replays scenarios through the REAL reducer
// (applyOps) and totals (computeTotals) and writes what happened as JSON. The
// Swift suite replays the same scenarios and must land on byte-identical
// state. Any reducer change here that the port hasn't absorbed turns the iOS
// suite red, which is the whole point.
//
//   npm run ios:fixtures            → writes .data/ios-fixtures/*.json
//   npm run ios:fixtures -- <dir>   → writes there instead (e.g. the iOS
//                                     repo's Tests/Fixtures)
//
// `expectedState` is stored as a STRING — the exact canonical bytes TS
// produced (sorted keys, compact) — so the Swift side compares its own
// encoder's output against these bytes, not a re-encoding of its own decode.
// That's what catches null-vs-absent drift, which is semantically real here
// (several readers treat `"kcal": null` differently from no key at all).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyOps, type Op } from "../shared/ops";
import { encodePolyline } from "../shared/polyline";
import type { ListState } from "../shared/types";
import { computeTotals } from "../shared/weights";

const outDir = process.argv[2] ?? ".data/ios-fixtures";

/** Sorted-key, compact stringify — the canonical byte form both sides emit. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(JSON.parse(JSON.stringify(value))));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function freshState(): ListState {
  return { title: "", displayUnit: "g", version: 0, folders: [], items: [] };
}

interface Fixture {
  name: string;
  initialState: ListState;
  ops: Op[];
  expectedState: string; // canonical JSON bytes
  expectedTotals: ReturnType<typeof computeTotals>;
}

function fixture(name: string, ops: Op[]): Fixture {
  // every fixture starts from the same blank list; the ops are the whole story
  const state = freshState();
  applyOps(state, ops);
  return {
    name,
    initialState: freshState(),
    ops,
    expectedState: canonical(state),
    expectedTotals: computeTotals(state),
  };
}

// A small real route: three points along a PNW-ish line (~2.5 km), and a loop
// whose ends close within LOOP_CLOSE_M. Encoded here with the real codec so
// the fixture exercises decode → seedRouteEnds → canonical re-encode.
const openRoute = encodePolyline([
  { lat: 45.3712, lon: -121.7093 },
  { lat: 45.3801, lon: -121.7011 },
  { lat: 45.3885, lon: -121.6952 },
]);
const loopRoute = encodePolyline([
  { lat: 45.3712, lon: -121.7093 },
  { lat: 45.3801, lon: -121.7011 },
  { lat: 45.3713, lon: -121.7094 },
]);

const fixtures: Fixture[] = [
  fixture("add-items-basic", [
    { t: "addFolder", folder: { id: "f1", name: "Shelter", colorKey: "shelter", defaultClassification: "base", sortOrder: 0 } },
    { t: "addFolder", folder: { id: "f2", name: "Food", colorKey: "consumable", defaultClassification: "consumable", sortOrder: 1 } },
    { t: "addItem", item: { id: "i1", folderId: "f1", name: "Duplex", brand: "Zpacks", unitWeightMg: 539000, qty: 1, classification: null, sortOrder: 0 } },
    { t: "addItem", item: { id: "i2", folderId: "f2", name: "Dinner", unitWeightMg: 120000, qty: 3, kcal: 650, classification: null, sortOrder: 0 } },
    { t: "addItem", item: { id: "i3", folderId: null, name: "Trekking poles", unitWeightMg: 250000, qty: 2, classification: "worn", sortOrder: 0 } },
  ]),

  fixture("classification-inherit-and-override", [
    { t: "addFolder", folder: { id: "worn", name: "On Body", colorKey: "worn", defaultClassification: "worn", sortOrder: 0 } },
    { t: "addItem", item: { id: "shoes", folderId: "worn", name: "Lone Peak", brand: "Altra", unitWeightMg: 620000, qty: 1, classification: null, sortOrder: 0 } },
    { t: "addItem", item: { id: "spares", folderId: "worn", name: "Camp shoes", unitWeightMg: 200000, qty: 1, classification: "base", sortOrder: 1 } },
    { t: "updateItem", id: "spares", patch: { classification: null } },
    { t: "updateItem", id: "spares", patch: { classification: "base" } },
  ]),

  fixture("worn-split-lifecycle", [
    { t: "addItem", item: { id: "socks", folderId: null, name: "Socks", brand: "Darn Tough", unitWeightMg: 61000, qty: 3, classification: "base", sortOrder: 0 } },
    // a genuine partial: 3 pairs, 1 worn
    { t: "updateItem", id: "socks", patch: { wornQty: 1 } },
    // all-worn collapses the split into the Worn class
    { t: "addItem", item: { id: "shirt", folderId: null, name: "Sun hoody", unitWeightMg: 150000, qty: 2, wornQty: 2, classification: "base", sortOrder: 1 } },
    // qty dropping under 2 drops the split
    { t: "addItem", item: { id: "hat", folderId: null, name: "Cap", unitWeightMg: 80000, qty: 3, wornQty: 1, classification: "base", sortOrder: 2 } },
    { t: "updateItem", id: "hat", patch: { qty: 1 } },
    // flipping to consumable clears a split in the same patch
    { t: "addItem", item: { id: "bar", folderId: null, name: "Bars", unitWeightMg: 68000, qty: 4, wornQty: 1, classification: "base", sortOrder: 3 } },
    { t: "updateItem", id: "bar", patch: { classification: "consumable", kcal: 250 } },
  ]),

  fixture("item-patch-three-state", [
    { t: "addItem", item: { id: "i1", folderId: null, name: "Stake set", unitWeightMg: 107730, qty: 1, entryUnit: "oz", classification: null, sortOrder: 0 } },
    // null CLEARS entryUnit back to the list unit; an invalid unit is IGNORED
    { t: "updateItem", id: "i1", patch: { entryUnit: null } },
    { t: "updateItem", id: "i1", patch: { entryUnit: "furlongs" as never } },
    { t: "updateItem", id: "i1", patch: { entryUnit: "oz" } },
    // kcal: set, then explicit-null clear, then zero-clears
    { t: "addItem", item: { id: "i2", folderId: null, name: "Olive oil", unitWeightMg: 250000, qty: 1, classification: "consumable", sortOrder: 1 } },
    { t: "updateItem", id: "i2", patch: { kcal: 2000 } },
    { t: "updateItem", id: "i2", patch: { kcal: null } },
    { t: "updateItem", id: "i2", patch: { kcal: 1800 } },
    { t: "updateItem", id: "i2", patch: { kcal: 0 } },
    // catalog link: link with stamp → free-rename null unlinks BOTH fields
    { t: "addItem", item: { id: "i3", folderId: null, name: "Tent", unitWeightMg: 539000, qty: 1, catalogItemId: 42, catalogWeightMgAtLink: 539000, classification: null, sortOrder: 2 } },
    { t: "updateItem", id: "i3", patch: { name: "My custom tarp", catalogItemId: null } },
    // re-link WITHOUT a stamp clears the stale baseline; with one, keeps it
    { t: "addItem", item: { id: "i4", folderId: null, name: "Quilt", unitWeightMg: 545000, qty: 1, catalogItemId: 7, catalogWeightMgAtLink: 700000, classification: null, sortOrder: 3 } },
    { t: "updateItem", id: "i4", patch: { catalogItemId: 8 } },
    { t: "addItem", item: { id: "i5", folderId: null, name: "Pad", unitWeightMg: 350000, qty: 1, catalogItemId: 9, catalogWeightMgAtLink: 350000, classification: null, sortOrder: 4 } },
    { t: "updateItem", id: "i5", patch: { catalogItemId: 10, catalogWeightMgAtLink: 360000 } },
  ]),

  fixture("text-tidy-and-clamps", [
    { t: "addFolder", folder: { id: "f1", name: "  ", colorKey: "shelter", defaultClassification: "base", sortOrder: 0 } },
    { t: "addFolder", folder: { id: "f2", name: "Ryan's Kit", colorKey: "not safe!", defaultClassification: "base", sortOrder: 1 } },
    { t: "addItem", item: { id: "i1", folderId: "f1", name: "﻿Zpacks  Duplex\n", brand: "Ryan's", unitWeightMg: 539000, qty: 1, classification: null, sortOrder: 0 } },
    // "" clears brand; whitespace-only clears too (the tidied value is read)
    { t: "updateItem", id: "i1", patch: { brand: "" } },
    { t: "addItem", item: { id: "i2", folderId: "f2", name: "6' guyline 2\" stake", unitWeightMg: 12000, qty: 1, classification: null, sortOrder: 0 } },
    // range clamps: weight over cap, qty over cap, negatives
    { t: "addItem", item: { id: "i3", folderId: null, name: "Anvil", unitWeightMg: 999999999999, qty: 99999, classification: null, sortOrder: 0 } },
    { t: "updateItem", id: "i3", patch: { unitWeightMg: -50, qty: -2 } },
    { t: "addItem", item: { id: "i4", folderId: null, name: "Feather", unitWeightMg: 1, qty: 1, kcal: 9999999, classification: "consumable", sortOrder: 1 } },
  ]),

  fixture("nesting-and-moves", [
    { t: "addFolder", folder: { id: "f1", name: "Shelter", colorKey: "shelter", defaultClassification: "base", sortOrder: 0 } },
    { t: "addFolder", folder: { id: "f2", name: "Sleep", colorKey: "sleep", defaultClassification: "base", sortOrder: 1 } },
    { t: "addItem", item: { id: "tent", folderId: "f1", name: "Tent", unitWeightMg: 800000, qty: 1, classification: null, sortOrder: 0 } },
    { t: "addItem", item: { id: "fly", folderId: "f2", parentId: "tent", name: "Fly", unitWeightMg: 300000, qty: 1, classification: null, sortOrder: 0 } },
    { t: "addItem", item: { id: "stakes", folderId: "f1", parentId: "tent", name: "Stakes", unitWeightMg: 100000, qty: 1, classification: null, sortOrder: 1 } },
    // a child of a child coerces to top-level (one level deep, acyclic)
    { t: "addItem", item: { id: "bag", folderId: "f1", parentId: "fly", name: "Stake bag", unitWeightMg: 10000, qty: 1, classification: null, sortOrder: 2 } },
    // parent crossing folders takes its children along
    { t: "moveItem", id: "tent", folderId: "f2", sortOrder: 5 },
    // un-nest, then re-nest under a different parent
    { t: "moveItem", id: "fly", folderId: "f2", sortOrder: 6, parentId: null },
    { t: "moveItem", id: "fly", folderId: "f2", sortOrder: 7, parentId: "tent" },
    // moving under an item that has children is refused (stays where sent)
    { t: "moveItem", id: "tent", folderId: "f2", sortOrder: 8, parentId: "fly" },
    // removing a parent takes its nested children with it
    { t: "addItem", item: { id: "pole", folderId: "f2", parentId: "tent", name: "Pole", unitWeightMg: 250000, qty: 1, classification: null, sortOrder: 3 } },
    { t: "removeItem", id: "tent" },
  ]),

  fixture("folder-ops", [
    { t: "addFolder", folder: { id: "f1", name: "Kit", colorKey: "pack", defaultClassification: "base", sortOrder: 0 } },
    // duplicate id ignored
    { t: "addFolder", folder: { id: "f1", name: "Kit again", colorKey: "sleep", defaultClassification: "worn", sortOrder: 1 } },
    // sortBy is GONE from Folder (#256 took per-folder sort out). These two stay as a
    // removed-field case, not a live feature: a client built before that still sends the
    // patch, so both reducers have to agree it is a no-op. `as never` because the field
    // no longer type-checks — which is the point of the fixture.
    { t: "updateFolder", id: "f1", patch: { sortBy: "heaviest" } as never },
    { t: "updateFolder", id: "f1", patch: { sortBy: "manual" } as never },
    { t: "updateFolder", id: "f1", patch: { name: "Big Kit", defaultClassification: "consumable" } },
    { t: "addFolder", folder: { id: "f2", name: "Doomed", colorKey: "water", defaultClassification: "base", sortOrder: 2 } },
    { t: "addItem", item: { id: "i1", folderId: "f2", name: "Casualty", unitWeightMg: 100000, qty: 1, classification: null, sortOrder: 0 } },
    { t: "removeFolder", id: "f2" },
    // adding into a deleted folder heals to ungrouped
    { t: "addItem", item: { id: "i2", folderId: "f2", name: "Orphan", unitWeightMg: 50000, qty: 1, classification: null, sortOrder: 0 } },
  ]),

  fixture("meta-and-dates", [
    { t: "setMeta", patch: { title: "  Timberline Loop  ", description: "Ryan's plan\n\n  with paragraphs kept\n" } },
    { t: "setMeta", patch: { displayUnit: "oz" } },
    { t: "setMeta", patch: { displayUnit: "stone" as never } },
    { t: "setMeta", patch: { startDate: "2026-08-14", endDate: "2026-02-31" } },
    { t: "setMeta", patch: { endDate: "2026-08-16" } },
    { t: "setMeta", patch: { trailUrl: "javascript:alert(1)" } },
    { t: "setMeta", patch: { trailUrl: "https://WWW.AllTrails.com/trail/us/oregon/timberline-trail" } },
    { t: "setMeta", patch: { trailLabel: "  " } },
    { t: "setMeta", patch: { trailDistanceM: "40.7 mi" as never } },
    { t: "setMeta", patch: { trailDistanceM: 65500 } },
    { t: "setMeta", patch: { trailDistanceUnit: "mi" } },
    { t: "setMeta", patch: { trailDistanceUnit: "leagues" } },
    { t: "setMeta", patch: { trailAscentM: 3048, trailDescentM: "" } },
  ]),

  fixture("days-and-waypoints", [
    { t: "addDay", day: { id: "d1", sortOrder: 0, label: "Over the pass", distanceM: 19000, ascentM: 1200 } },
    { t: "addDay", day: { id: "d2", sortOrder: 1 } },
    { t: "updateDay", id: "d2", patch: { rest: true } },
    { t: "updateDay", id: "d2", patch: { rest: false as never } },
    { t: "updateDay", id: "d2", patch: { distanceM: 12000, ascentM: 400, rest: true } },
    // "" is the erase sentinel; zero clears rather than claims
    { t: "updateDay", id: "d1", patch: { ascentM: "" } },
    { t: "updateDay", id: "d1", patch: { distanceM: 0 } },
    { t: "addDay", day: { id: "d3", sortOrder: 2, distanceM: 999999999, ascentM: 99999 } },
    { t: "removeDay", id: "d3" },
    // route arrives → ends seeded; changing it reseeds; clearing empties pins
    { t: "setMeta", patch: { routeGeometry: openRoute } },
    { t: "addWaypoint", waypoint: { id: "w1", kind: "water", alongM: 1200, label: "spring, 40m off trail" } },
    { t: "updateWaypoint", id: "w1", patch: { alongM: 1350, note: "reliable" } },
    { t: "updateWaypoint", id: "w1", patch: { kind: "nonsense" as never, label: "" } },
    { t: "addWaypoint", waypoint: { id: "w2", kind: "camp", alongM: -5 } },
    { t: "removeWaypoint", id: "wp-end" },
  ]),

  fixture("route-loop-single-pin", [
    { t: "setMeta", patch: { routeGeometry: loopRoute } },
  ]),

  fixture("route-change-reseeds", [
    { t: "setMeta", patch: { routeGeometry: openRoute } },
    { t: "addWaypoint", waypoint: { id: "w1", kind: "water", alongM: 900 } },
    // same geometry re-saved keeps the pins
    { t: "setMeta", patch: { routeGeometry: openRoute } },
    // a DIFFERENT route replaces them with fresh ends
    { t: "setMeta", patch: { routeGeometry: loopRoute } },
    // clearing the geometry empties the pins (present-but-empty array)
    { t: "setMeta", patch: { routeGeometry: "" } },
  ]),

  fixture("merge-safety", [
    { t: "addItem", item: { id: "i1", folderId: null, name: "First", unitWeightMg: 1000, qty: 1, classification: null, sortOrder: 0 } },
    { t: "addItem", item: { id: "i1", folderId: null, name: "Duplicate ignored", unitWeightMg: 9000, qty: 9, classification: null, sortOrder: 1 } },
    { t: "updateItem", id: "ghost", patch: { name: "No such row" } },
    { t: "removeItem", id: "ghost" },
    { t: "removeFolder", id: "ghost" },
    { t: "updateDay", id: "ghost", patch: { distanceM: 1 } },
    { t: "removeWaypoint", id: "ghost" },
  ]),

  fixture("unicode-names", [
    { t: "addFolder", folder: { id: "f1", name: "山田　太郎", colorKey: "kitchen", defaultClassification: "base", sortOrder: 0 } },
    { t: "addItem", item: { id: "i1", folderId: "f1", name: "Arc'teryx Beta 🏔️", unitWeightMg: 350000, qty: 1, classification: null, sortOrder: 0 } },
    { t: "addItem", item: { id: "i2", folderId: "f1", name: "l'eau", unitWeightMg: 1000000, qty: 1, classification: "consumable", sortOrder: 1 } },
  ]),
];

mkdirSync(outDir, { recursive: true });
for (const f of fixtures) {
  writeFileSync(join(outDir, `${f.name}.json`), canonical(f) + "\n");
}
console.log(`wrote ${fixtures.length} fixtures to ${outDir}`);
