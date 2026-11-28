// Golden fixtures for the native iOS port's conformance suite.
//
// The iOS app (github.com/ryankiley/mahonia-ios) carries a Swift port of the
// shared/ op-reducer, and two implementations of one reducer WILL drift
// silently — so these scenarios are replayed through the REAL reducer
// (applyOps) and totals (computeTotals) and what happened is written as JSON
// (scripts/emit-ios-fixtures.ts, `npm run ios:fixtures`). The Swift suite
// replays the same scenarios and must land on byte-identical state. Any reducer
// change here that the port hasn't absorbed turns the iOS suite red, which is
// the whole point.
//
// That only holds for a rule a scenario EXERCISES. The table sat still from
// August to November 2026 while the reducer gained people, needs-cooking, day
// notes and five tidy and validation rules, so the port fell three months behind
// with a green suite. tests/iosFixtures.test.ts now fails when an op kind has no
// scenario; a new RULE on an existing op still needs its scenario added by hand,
// in the same PR as the rule.
//
// Only the FINAL state is compared, so a scenario proves a rule only when the
// rule shows in what is left standing: one row per rule, not one row walked
// through several.
//
// Every op here is one a typed client could send: the right JSON type in every
// field, with values a field or a hostile caller could put there. An op with the
// wrong type in a field (a number where a string goes) is the server's to refuse,
// and the port's reducer only ever replays ops its own app built.
//
// `expectedState` is stored as a STRING — the exact canonical bytes TS
// produced (sorted keys, compact) — so the Swift side compares its own
// encoder's output against these bytes, not a re-encoding of its own decode.
// That's what catches null-vs-absent drift, which is semantically real here
// (several readers treat `"kcal": null` differently from no key at all).

import { readFileSync } from "node:fs";
import { keptGearType, pickFromCatalog, type CatalogPickOwn, type CatalogPickRow } from "../shared/catalogMatch";
import { cloneListData } from "../shared/clone";
import { csvToListData, listToCsv, parseCsv } from "../shared/exporters/csv";
import { jsonToListImport, listToJson } from "../shared/exporters/json";
import { listToMarkdown } from "../shared/exporters/markdown";
import { listToText } from "../shared/exporters/text";
import { GEAR_GLYPHS, gearFamilyOf, gearGlyphFor } from "../shared/gearGlyph";
import { parsePriceInput } from "../shared/money";
import { applyOps, tidyStoredList, type Op } from "../shared/ops";
import { encodePolyline } from "../shared/polyline";
import { parseDistanceM } from "../shared/trailDistance";
import { CLEARS_WITH_LINK } from "../shared/trailLink";
import type { Folder, Item, ListSnapshot, ListState, Waypoint } from "../shared/types";
import { pickListMeta } from "../shared/types";
import { parseVolumeMl } from "../shared/water";
import { computeTotals, parseDecimal, parseKcal, parseWeightInput } from "../shared/weights";
import { CATALOG_CSV } from "./paths";

/** Sorted-key, compact stringify — the canonical byte form both sides emit. */
export function canonical(value: unknown): string {
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

export interface Fixture {
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

/** A plain base row, for the scenarios where the row itself isn't the subject. */
const row = (id: string, name: string, extra: Record<string, unknown> = {}): Op =>
  ({
    t: "addItem",
    item: { id, folderId: null, name, unitWeightMg: 100000, qty: 1, classification: null, sortOrder: 0, ...extra },
  }) as Op;

export const fixtures: Fixture[] = [
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

  // water is a volume, never a count (foldWaterQty): a count folds into the volume on
  // add, on a qty set and on a rename; a name ending in the word is water, gear isn't
  fixture("water-is-a-volume", [
    { t: "addItem", item: { id: "w1", folderId: null, name: "Water", unitWeightMg: 1000000, qty: 3, classification: "consumable", sortOrder: 0 } },
    { t: "addItem", item: { id: "w2", folderId: null, name: "Drinking water", unitWeightMg: 750000, qty: 1, classification: "consumable", sortOrder: 1 } },
    { t: "updateItem", id: "w2", patch: { qty: 2 } },
    { t: "addItem", item: { id: "b1", folderId: null, name: "Bottle", unitWeightMg: 500000, qty: 2, classification: null, sortOrder: 2 } },
    { t: "updateItem", id: "b1", patch: { name: "Water (1 L)" } },
    { t: "addItem", item: { id: "g1", folderId: null, name: "Water filter", unitWeightMg: 85000, qty: 2, classification: null, sortOrder: 3 } },
    { t: "addItem", item: { id: "g2", folderId: null, name: "Smartwater", unitWeightMg: 40000, qty: 2, classification: null, sortOrder: 4 } },
    { t: "addItem", item: { id: "z1", folderId: null, name: "Spare water", unitWeightMg: 500000, qty: 0, classification: "consumable", sortOrder: 5 } },
  ]),

  fixture("unicode-names", [
    { t: "addFolder", folder: { id: "f1", name: "山田　太郎", colorKey: "kitchen", defaultClassification: "base", sortOrder: 0 } },
    { t: "addItem", item: { id: "i1", folderId: "f1", name: "Arc'teryx Beta 🏔️", unitWeightMg: 350000, qty: 1, classification: null, sortOrder: 0 } },
    { t: "addItem", item: { id: "i2", folderId: "f1", name: "l'eau", unitWeightMg: 1000000, qty: 1, classification: "consumable", sortOrder: 1 } },
  ]),

  // ---- people (#245): three ops, and who carries a row ---------------------------

  // a name is an identity, one id is reserved, and a person is never nameless
  fixture("people-ops", [
    { t: "addPerson", person: { id: "p1", name: "  Sam  ", colorKey: "shelter", sortOrder: 0 } },
    // a replayed add is a no-op, not a second Sam
    { t: "addPerson", person: { id: "p1", name: "Sam again", colorKey: "sleep", sortOrder: 5 } },
    // the same name by case and padding is refused
    { t: "addPerson", person: { id: "p2", name: " sAM ", colorKey: "sleep", sortOrder: 1 } },
    // the Unassigned chip's word is not an id anyone may claim
    { t: "addPerson", person: { id: "unassigned", name: "Nobody", sortOrder: 2 } },
    // a blank name becomes "Person", an unsafe colour "other"
    { t: "addPerson", person: { id: "p3", name: "   ", colorKey: "not safe!", sortOrder: 2 } },
    // a second blank one would be a second "Person": refused
    { t: "addPerson", person: { id: "p4", name: "", sortOrder: 3 } },
    // no colour is "other" too, and a name past the cap is cut to it
    { t: "addPerson", person: { id: "p5", name: "A".repeat(70), sortOrder: 4 } },
    { t: "addPerson", person: { id: "p6", name: "Dana O'Brien", colorKey: "water", sortOrder: 5 } },
    // a rename onto a taken name is dropped; the colour and order beside it land
    { t: "updatePerson", id: "p6", patch: { name: "SAM", colorKey: "kitchen", sortOrder: 9 } },
    // a rename to nothing is ignored
    { t: "updatePerson", id: "p6", patch: { name: "  " } },
    // your own name in another case is no collision with yourself
    { t: "updatePerson", id: "p1", patch: { name: "SAM" } },
    { t: "updatePerson", id: "p1", patch: { colorKey: "url(x)" } },
    { t: "addPerson", person: { id: "p7", name: "Leaving", sortOrder: 6 } },
    { t: "removePerson", id: "p7" },
    { t: "updatePerson", id: "ghost", patch: { name: "Nobody" } },
    { t: "removePerson", id: "ghost" },
  ]),

  fixture("people-cap", [
    ...Array.from(
      { length: 13 },
      (_, i): Op => ({ t: "addPerson", person: { id: `p${i + 1}`, name: `Hiker ${i + 1}`, sortOrder: i } }),
    ),
    // the thirteenth never joined, so nothing can be theirs
    row("i1", "Tent", { personId: "p13" }),
    row("i2", "Stove", { personId: "p12", sortOrder: 1 }),
  ]),

  // a list nobody was ever added to has no `people` key, whatever is thrown at it…
  fixture("people-never-added", [
    row("i1", "Tent", { personId: "sam" }),
    { t: "updateItem", id: "i1", patch: { personId: "sam" } },
    { t: "updatePerson", id: "sam", patch: { name: "Sam" } },
    { t: "removePerson", id: "sam" },
  ]),

  // …and one whose last person left keeps the key, empty
  fixture("people-all-removed", [
    { t: "addPerson", person: { id: "sam", name: "Sam", colorKey: "shelter", sortOrder: 0 } },
    row("i1", "Tent", { personId: "sam" }),
    { t: "removePerson", id: "sam" },
  ]),

  fixture("person-assignment", [
    { t: "addPerson", person: { id: "sam", name: "Sam", colorKey: "shelter", sortOrder: 0 } },
    { t: "addPerson", person: { id: "alex", name: "Alex", colorKey: "sleep", sortOrder: 1 } },
    { t: "addPerson", person: { id: "kim", name: "Kim", colorKey: "water", sortOrder: 2 } },
    row("tent", "Tent", { personId: "sam" }),
    // an assignee the list doesn't have heals to unassigned, on add…
    row("stove", "Stove", { personId: "ghost", sortOrder: 1 }),
    // a child may name its own carrier, or none and follow its parent
    row("stakes", "Stakes", { parentId: "tent", personId: "kim", sortOrder: 2 }),
    row("fly", "Fly", { parentId: "tent", sortOrder: 3 }),
    // …and on update, where it also drops the carrier the row had
    row("quilt", "Quilt", { personId: "sam", sortOrder: 4 }),
    { t: "updateItem", id: "quilt", patch: { personId: "ghost" } },
    // "" is not a clear: null is
    row("pad", "Pad", { personId: "sam", sortOrder: 5 }),
    { t: "updateItem", id: "pad", patch: { personId: "" } },
    row("pot", "Pot", { personId: "sam", sortOrder: 6 }),
    { t: "updateItem", id: "pot", patch: { personId: null } },
    // set by a patch; an unrelated patch leaves it standing
    row("cup", "Cup", { sortOrder: 7 }),
    { t: "updateItem", id: "cup", patch: { personId: "sam" } },
    { t: "updateItem", id: "cup", patch: { name: "Mug" } },
    // an id past the cap is cut, and then names nobody
    row("spoon", "Spoon", { personId: "sam".padEnd(140, "x"), sortOrder: 8 }),
    // removing someone clears their rows and nobody else's; the rows stay
    row("filter", "Filter", { personId: "alex", sortOrder: 9 }),
    { t: "removePerson", id: "alex" },
  ]),

  // ---- needs cooking (#418) ------------------------------------------------------

  fixture("needs-cooking", [
    row("ramen", "Ramen", { classification: "consumable", kcal: 380, needsCooking: true }),
    // false is not stored: absent is how a row says it needs no stove
    row("bar", "Bar", { classification: "consumable", needsCooking: false, sortOrder: 1 }),
    row("oats", "Oats", { classification: "consumable", sortOrder: 2 }),
    { t: "updateItem", id: "oats", patch: { needsCooking: true } },
    row("rice", "Rice", { classification: "consumable", needsCooking: true, sortOrder: 3 }),
    { t: "updateItem", id: "rice", patch: { needsCooking: false } },
    // the flag is the row's, whatever its class, and an unrelated patch leaves it
    row("pot", "Pot", { needsCooking: true, sortOrder: 4 }),
    { t: "updateItem", id: "pot", patch: { qty: 2 } },
  ]),

  // ---- day notes (#495), and labels tidied rather than only cut --------------------

  fixture("day-and-waypoint-text", [
    { t: "addDay", day: { id: "d1", sortOrder: 0, label: "  Ryan's   pass ", note: "  Resupply at Red's \r\n  shuttle at 8  " } },
    // blank is absent, not ""
    { t: "addDay", day: { id: "d2", sortOrder: 1, label: "   ", note: "  " } },
    // "" clears both, by patch
    { t: "addDay", day: { id: "d3", sortOrder: 2, label: "Camp", note: "keep" } },
    { t: "updateDay", id: "d3", patch: { label: "", note: "" } },
    { t: "addDay", day: { id: "d4", sortOrder: 3, label: "l".repeat(130), note: "n".repeat(510) } },
    { t: "addDay", day: { id: "d5", sortOrder: 4 } },
    { t: "updateDay", id: "d5", patch: { label: " Tom's  ford ", note: " cross early\n\n water's high by noon " } },
    { t: "addWaypoint", waypoint: { id: "w1", kind: "water", alongM: 1200, label: "  spring,  40m off trail ", note: " Ryan's cache \n behind the sign " } },
    { t: "addWaypoint", waypoint: { id: "w2", kind: "camp", alongM: 2000, label: "  ", note: " " } },
    { t: "addWaypoint", waypoint: { id: "w3", kind: "landmark", alongM: 3000, label: "Cairn", note: "keep" } },
    { t: "updateWaypoint", id: "w3", patch: { label: "  ", note: "" } },
    { t: "addWaypoint", waypoint: { id: "w4", kind: "water", alongM: 4000 } },
    { t: "updateWaypoint", id: "w4", patch: { label: "l".repeat(130), note: "n".repeat(510) } },
  ]),

  // ---- a product link is http(s) or it is no link ----------------------------------

  fixture("product-url-scheme", [
    // stored as typed: an apostrophe in a path is part of the address
    row("a", "Jacket", { productUrl: "https://example.com/men's-jacket" }),
    row("b", "Pad", { productUrl: "  https://example.com/pad  ", sortOrder: 1 }),
    row("c", "Script", { productUrl: "javascript:alert(1)", sortOrder: 2 }),
    row("d", "File", { productUrl: "ftp://example.com/file", sortOrder: 3 }),
    row("e", "Bare", { productUrl: "example.com/tent", sortOrder: 4 }),
    row("f", "Quilt", { productUrl: "HTTPS://EXAMPLE.COM/Quilt", sortOrder: 5 }),
    row("g", "Long", { productUrl: `https://example.com/${"a".repeat(2100)}`, sortOrder: 6 }),
    // by patch: a hostile value clears what was there, and so does ""
    row("h", "Stove", { productUrl: "https://example.com/stove", sortOrder: 7 }),
    { t: "updateItem", id: "h", patch: { productUrl: "javascript:alert(1)" } },
    row("i", "Pot", { productUrl: "https://example.com/pot", sortOrder: 8 }),
    { t: "updateItem", id: "i", patch: { productUrl: "" } },
    row("j", "Cup", { sortOrder: 9 }),
    { t: "updateItem", id: "j", patch: { productUrl: " http://example.com/cup " } },
  ]),

  // ---- what it cost: the amount and its currency travel as one ----------------------

  fixture("price-and-currency", [
    row("a", "Tent", { priceCents: 69900, currency: "USD" }),
    row("b", "Pad", { priceCents: 2000, sortOrder: 1 }),
    // a currency with no amount says nothing: not kept, off a whole row as by patch
    row("c", "Pot", { currency: "EUR", sortOrder: 2 }),
    row("d", "Cup", { priceCents: -5, currency: "LONGCURRENCY", sortOrder: 3 }),
    row("e", "Quilt", { priceCents: 1000, currency: "USD", sortOrder: 4 }),
    { t: "updateItem", id: "e", patch: { priceCents: 2499, currency: "CAD" } },
    // an amount that names no currency takes none, rather than keeping the last one's
    row("f", "Stove", { priceCents: 1000, currency: "USD", sortOrder: 5 }),
    { t: "updateItem", id: "f", patch: { priceCents: 900 } },
    // a currency alone would re-denominate the figure already there: ignored
    row("g", "Spoon", { priceCents: 1000, currency: "USD", sortOrder: 6 }),
    { t: "updateItem", id: "g", patch: { currency: "GBP" } },
    row("h", "Filter", { sortOrder: 7 }),
    { t: "updateItem", id: "h", patch: { priceCents: -1, currency: "TOOLONGCODE" } },
    // free is a price
    row("i", "Bandana", { priceCents: 1000, currency: "USD", sortOrder: 8 }),
    { t: "updateItem", id: "i", patch: { priceCents: 0 } },
    // and a currency patched onto a row with no amount lands nowhere
    row("j", "Fork", { sortOrder: 9 }),
    { t: "updateItem", id: "j", patch: { currency: "GBP" } },
  ]),

  // ---- a catalog id is one the database can hold ------------------------------------

  fixture("catalog-id-range", [
    // the id goes, and the weight it was linked at goes with it: the weight describes
    // the linked product, so a row with no link has none
    row("a", "Zero", { catalogItemId: 0, catalogWeightMgAtLink: 100000 }),
    row("b", "Negative", { catalogItemId: -3, sortOrder: 1 }),
    row("c", "Past the top", { catalogItemId: 2147483648, sortOrder: 2 }),
    row("d", "The top", { catalogItemId: 2147483647, sortOrder: 3 }),
    // by patch an unusable id is ignored and the link stands…
    row("e", "Linked", { catalogItemId: 5, catalogWeightMgAtLink: 300000, sortOrder: 4 }),
    { t: "updateItem", id: "e", patch: { catalogItemId: 0 } },
    // …while a weight stamped in the same patch still lands
    row("f", "Restamped", { catalogItemId: 5, catalogWeightMgAtLink: 300000, sortOrder: 5 }),
    { t: "updateItem", id: "f", patch: { catalogItemId: 2147483648, catalogWeightMgAtLink: 123456 } },
  ]),

  // ---- one rule for a whole row and for a patch --------------------------------------
  // The reducer read a row's fields by two lists of rules, one for a whole row and one
  // for a patch, and five fields had drifted between them. Each row here is one of
  // those, in the form both paths now store.

  fixture("whole-row-and-patch-agree", [
    { t: "addFolder", folder: { id: "f1", name: "Kit", colorKey: "pack", defaultClassification: "base", sortOrder: 0 } },
    // a folder keeps a name: a rename to nothing is ignored, as a person's is, and the
    // colour in the same patch still lands
    { t: "updateFolder", id: "f1", patch: { name: "  ", colorKey: "sleep" } },
    // a note cleared by patch is absent, not "": the empty string, and one that only
    // looks empty
    row("note", "Stakes", { description: "spare" }),
    { t: "updateItem", id: "note", patch: { description: "" } },
    row("blank-note", "Pot", { description: "lid", sortOrder: 1 }),
    { t: "updateItem", id: "blank-note", patch: { description: " \u2800 " } },
    // the two "renamed" flags are stored only when set. false clears one that was set…
    row("flags", "Tent", { nameOverridden: true, commonNameOverridden: true, sortOrder: 2 }),
    { t: "updateItem", id: "flags", patch: { nameOverridden: false, commonNameOverridden: false } },
    // …stores nothing on a row that had none (what a catalog pick in a row's name sends)…
    row("unset", "Pad", { sortOrder: 3 }),
    { t: "updateItem", id: "unset", patch: { nameOverridden: false, commonNameOverridden: false } },
    // …and true sets them, by patch and off a whole row
    row("set", "Quilt", { sortOrder: 4 }),
    { t: "updateItem", id: "set", patch: { nameOverridden: true, commonNameOverridden: true } },
    row("whole-set", "Cup", { nameOverridden: true, commonNameOverridden: true, sortOrder: 5 }),
    row("whole-unset", "Mug", { nameOverridden: false, commonNameOverridden: false, sortOrder: 6 }),
    // the catalog's weight at link time is kept only beside a link: not off a whole row
    // that has none, not by a patch onto an unlinked row…
    row("orphan", "Stove", { catalogWeightMgAtLink: 100000, sortOrder: 7 }),
    row("bare", "Spoon", { sortOrder: 8 }),
    { t: "updateItem", id: "bare", patch: { catalogWeightMgAtLink: 100000 } },
    // …and an unlink takes the weight stamped in the same patch with it
    row("unlinked", "Fly", { catalogItemId: 5, catalogWeightMgAtLink: 300000, sortOrder: 9 }),
    { t: "updateItem", id: "unlinked", patch: { catalogItemId: null, catalogWeightMgAtLink: 123456 } },
    // beside a link it lands, by patch onto a linked row
    row("linked", "Pole", { catalogItemId: 5, sortOrder: 10 }),
    { t: "updateItem", id: "linked", patch: { catalogWeightMgAtLink: 250000 } },
  ]),

  // ---- text that draws nothing (#565, #568) ----------------------------------------

  fixture("tidy-hidden-and-blank", [
    // the bidi overrides and isolates go: they make stored and rendered text disagree
    { t: "setMeta", patch: { title: "‮Down quilt⁦ g 002⁩", description: "‫notes‬" } },
    // a value made only of characters that render as nothing is empty
    { t: "addFolder", folder: { id: "f1", name: "ㅤㅤ", colorKey: "shelter", defaultClassification: "base", sortOrder: 0 } },
    { t: "addPerson", person: { id: "p1", name: "⠀", sortOrder: 0 } },
    row("blank", "‍­", { brand: "⁠", variant: "᠎", commonName: "ᅟ ᅠ", description: "ﾠ" }),
    // a complete subdivision flag keeps its tag characters; any other tag character goes
    row("flag", "Flag \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} tarp", { sortOrder: 1 }),
    row("tags", "Hid\u{E0068}\u{E0069}den\u{E007F}", { sortOrder: 2 }),
    row("broken", "Broken \u{1F3F4}\u{E0067}\u{E0062} flag", { sortOrder: 3 }),
    // the joiner inside an emoji and a direction mark beside a letter are content
    row("zwj", "\u{1F469}‍\u{1F680} patch", { sortOrder: 4 }),
    row("lrm", "‎שלום tent", { sortOrder: 5 }),
    row("renamed", "Named", { brand: "Kept", sortOrder: 6 }),
    { t: "updateItem", id: "renamed", patch: { name: "⠀⠀", brand: "­" } },
  ]),

  // ---- counts at their edges --------------------------------------------------------

  fixture("qty-zero-and-worn-edges", [
    { t: "addFolder", folder: { id: "worn", name: "On body", colorKey: "worn", defaultClassification: "worn", sortOrder: 0 } },
    // zero is a count; only a missing one defaults to one
    row("a", "Spare socks", { qty: 0 }),
    row("b", "Gloves", { qty: 3, sortOrder: 1 }),
    { t: "updateItem", id: "b", patch: { qty: 0 } },
    row("c", "Hat", { qty: undefined, sortOrder: 2 }),
    // a worn count past the row's is the whole row worn; below one is no split
    row("d", "Shirts", { qty: 5, wornQty: 99999, classification: "base", sortOrder: 3 }),
    row("e", "Shorts", { qty: 5, wornQty: -1, classification: "base", sortOrder: 4 }),
    // a row that inherits Worn from its folder still stores the split it was given
    row("f", "Liners", { folderId: "worn", qty: 3, wornQty: 1, sortOrder: 5 }),
    row("g", "Bars", { qty: 4, wornQty: 2, classification: "consumable", sortOrder: 6 }),
    row("h", "Buffs", { qty: 4, classification: "base", sortOrder: 7 }),
    { t: "updateItem", id: "h", patch: { wornQty: 4 } },
    // the count falling to the split turns the row Worn
    row("i", "Tops", { qty: 5, wornQty: 2, classification: "base", sortOrder: 8 }),
    { t: "updateItem", id: "i", patch: { qty: 2 } },
    row("j", "Mitts", { qty: 5, wornQty: 2, classification: "base", sortOrder: 9 }),
    { t: "updateItem", id: "j", patch: { wornQty: 0 } },
    row("k", "Caps", { qty: 5, wornQty: 2, classification: "base", sortOrder: 10 }),
    { t: "updateItem", id: "k", patch: { wornQty: -3 } },
  ]),

  // ---- every text cap, ten past it --------------------------------------------------

  fixture("text-caps", [
    { t: "setMeta", patch: { title: "t".repeat(210), description: "d".repeat(4010), trailLabel: "l".repeat(130) } },
    { t: "addFolder", folder: { id: "f1", name: "f".repeat(130), colorKey: "shelter", defaultClassification: "base", sortOrder: 0 } },
    { t: "addFolder", folder: { id: "f2", name: "Short", colorKey: "sleep", defaultClassification: "base", sortOrder: 1 } },
    { t: "updateFolder", id: "f2", patch: { name: "g".repeat(130) } },
    row("i".repeat(140), "n".repeat(210), {
      brand: "b".repeat(130),
      variant: "v".repeat(130),
      commonName: "c".repeat(130),
      description: "o".repeat(2010),
    }),
    row("patched", "Short", { sortOrder: 1 }),
    {
      t: "updateItem",
      id: "patched",
      patch: {
        name: "N".repeat(210),
        brand: "B".repeat(130),
        variant: "V".repeat(130),
        commonName: "C".repeat(130),
        description: "O".repeat(2010),
      },
    },
    // the cut comes BEFORE the tidy, so one that lands on a space doesn't keep it
    row("cut", `${"a".repeat(199)} b`, { sortOrder: 2 }),
  ]),

  // ---- fields that are gone, still arriving from a client built before they went -----

  fixture("removed-fields", [
    // a folder's sort (#256) and a row's image are dropped on the way in
    { t: "addFolder", folder: { id: "f1", name: "Kit", colorKey: "pack", defaultClassification: "base", sortOrder: 0, sortBy: "heaviest" } as never },
    row("i1", "Tent", { folderId: "f1", imageUrl: "https://example.com/tent.png" }),
    row("i2", "Pad", { folderId: "f1", sortOrder: 1 }),
    { t: "updateItem", id: "i2", patch: { imageUrl: "https://example.com/pad.png" } as never },
  ]),

  // ---- the route's own facts --------------------------------------------------------

  fixture("meta-rules", [
    { t: "setMeta", patch: { trailUrl: "https://example.com/trail", trailLabel: "  Ryan's   loop " } },
    // metres arrive as a number, or as the text of one
    { t: "setMeta", patch: { trailAscentM: "1200.6" } },
    // out of range is not a shorter route: it clears what was there
    { t: "setMeta", patch: { trailDistanceM: 65500, trailDescentM: 1180 } },
    { t: "setMeta", patch: { trailDistanceM: 10000001, trailDescentM: 30001 } },
    // elevations are rounded on the way in
    { t: "setMeta", patch: { trailProfile: "100,250.4,9000,-500" } },
  ]),

  // removing a link clears what described the route it pointed at, and not the
  // distance (#554): that is the trip's, typed whether or not there's a link
  fixture("link-removed-keeps-distance", [
    {
      t: "setMeta",
      patch: {
        trailUrl: "https://example.com/trail",
        trailLabel: "Timberline",
        trailDistanceM: 65500,
        trailAscentM: 2700,
        trailDescentM: 2700,
        trailProfile: "1200,1500,1300",
        routeGeometry: openRoute,
      },
    },
    { t: "addWaypoint", waypoint: { id: "w1", kind: "water", alongM: 900 } },
    { t: "setMeta", patch: { trailUrl: "", ...CLEARS_WITH_LINK } },
  ]),
];

// ---- vectors -----------------------------------------------------------------------
// The port's pure functions whose output is TEXT someone else reads: the exporters
// (the server serves listToMarkdown's bytes at /s/{code}.md, and a CSV written on a
// phone is read back on the web) and the gear-type → icon table, a long ordered list
// of patterns where one out of place moves a piece to another kind. Pinned byte for
// byte, like the reducer's state, and written to a vectors/ folder beside the
// fixtures.

export interface ExportVector {
  name: string;
  list: ListSnapshot;
  shareUrl: string;
  markdown: string;
  text: string;
  csv: string;
}

const SHARE_URL = "https://mahonia.app/s/abc123";

function exportVector(name: string, ops: Op[]): ExportVector {
  const list: ListSnapshot = { ...freshState(), shareCode: "abc123", slug: "" };
  applyOps(list, ops);
  return {
    name,
    list,
    shareUrl: SHARE_URL,
    markdown: listToMarkdown(list),
    text: listToText(list, { shareUrl: SHARE_URL }),
    csv: listToCsv(list),
  };
}

export const exportVectors: ExportVector[] = [
  // everything a row can be at once: people, a group, a worn split, water, food
  exportVector("group-trip", [
    { t: "setMeta", patch: { title: "Ryan's Timberline", description: "Three days, two of us." } },
    { t: "addFolder", folder: { id: "f1", name: "Shelter", colorKey: "shelter", defaultClassification: "base", sortOrder: 0 } },
    { t: "addFolder", folder: { id: "f2", name: "Kitchen", colorKey: "kitchen", defaultClassification: "consumable", sortOrder: 1 } },
    { t: "addFolder", folder: { id: "f3", name: "On body", colorKey: "worn", defaultClassification: "worn", sortOrder: 2 } },
    { t: "addFolder", folder: { id: "f4", name: "Empty", colorKey: "other", defaultClassification: "base", sortOrder: 3 } },
    { t: "addPerson", person: { id: "sam", name: "Sam", colorKey: "shelter", sortOrder: 0 } },
    { t: "addPerson", person: { id: "alex", name: "Alex", colorKey: "sleep", sortOrder: 1 } },
    row("tent", "Duplex", { folderId: "f1", brand: "Zpacks", variant: "Olive", commonName: "Tent", unitWeightMg: 539000, personId: "sam" }),
    row("stakes", "Stakes", { folderId: "f1", parentId: "tent", unitWeightMg: 10000, qty: 8, personId: "alex", sortOrder: 1 }),
    row("fly", "Groundsheet", { folderId: "f1", parentId: "tent", unitWeightMg: 95000, sortOrder: 2 }),
    // a brand the name already opens with is said once
    row("pack", "Zpacks Arc Haul", { folderId: "f1", brand: "Zpacks", commonName: "Backpack", unitWeightMg: 595000, personId: "alex", sortOrder: 3 }),
    // a bare group: no weight of its own, its line is what's inside it
    row("kit", "Cook kit", { folderId: "f2", unitWeightMg: 0, classification: "base", sortOrder: 0 }),
    row("pot", "Pot", { folderId: "f2", parentId: "kit", unitWeightMg: 110000, classification: "base", sortOrder: 1 }),
    row("stove", "PocketRocket", { folderId: "f2", parentId: "kit", brand: "MSR", commonName: "Stove", unitWeightMg: 73000, classification: "base", sortOrder: 2 }),
    row("ramen", "Ramen", { folderId: "f2", unitWeightMg: 85000, qty: 3, kcal: 380, needsCooking: true, sortOrder: 3 }),
    row("water", "Water", { folderId: "f2", unitWeightMg: 2000000, sortOrder: 4 }),
    row("socks", "Socks", { folderId: "f3", brand: "Darn Tough", unitWeightMg: 61000, qty: 3, wornQty: 1, classification: "base", sortOrder: 0 }),
    row("shoes", "Lone Peak 9+", { folderId: "f3", brand: "Altra", commonName: "Trail runners", unitWeightMg: 310000, qty: 2, sortOrder: 1 }),
    // characters a table or a spreadsheet would read as something else
    row("odd", "Tarp | spare <patch>, \"2 in\"", { unitWeightMg: 12500, description: "=SUM(A1), a note", sortOrder: 0 }),
    row("zero", "Unweighed", { unitWeightMg: 0, sortOrder: 1 }),
    row("none", "Left at home", { unitWeightMg: 40000, qty: 0, sortOrder: 2 }),
  ]),

  exportVector("imperial", [
    { t: "setMeta", patch: { title: "Weekend", displayUnit: "oz" } },
    { t: "addFolder", folder: { id: "f1", name: "Sleep", colorKey: "sleep", defaultClassification: "base", sortOrder: 0 } },
    row("quilt", "Revelation", { folderId: "f1", brand: "Enlightened Equipment", variant: "20F, Regular", commonName: "Quilt", unitWeightMg: 607000, entryUnit: "lb" }),
    row("pad", "NeoAir XLite NXT", { folderId: "f1", brand: "Therm-a-Rest", commonName: "Sleeping pad", unitWeightMg: 354000, sortOrder: 1 }),
    row("pillow", "Pillow", { folderId: "f1", unitWeightMg: 1, sortOrder: 2 }),
  ]),

  // nothing weighed: no totals block, no closing sentence
  exportVector("no-weights", [
    row("a", "Tent", { unitWeightMg: 0 }),
    row("b", "Quilt", { unitWeightMg: 0, qty: 2, sortOrder: 1 }),
  ]),

  exportVector("empty", []),

  // What the share page says above a list, and the rows a pasted table used to get
  // wrong: the trail, dates and distance (in the list's own distance unit, not its
  // weights' system), two groups of one name told apart by their notes, a gear type the
  // name already says, the same food in two groups (said once in the text), a row typed
  // in ounces on a pounds list, a weight that is 0.1 lb as written, a row in no folder.
  exportVector("trip-notes", [
    {
      t: "setMeta",
      patch: {
        title: "Timberline",
        displayUnit: "lb",
        trailLabel: "Timberline Trail #600",
        startDate: "2026-09-07",
        endDate: "2026-09-10",
        trailDistanceM: 64042,
        trailDistanceUnit: "km",
      },
    },
    { t: "addFolder", folder: { id: "f1", name: "Food", colorKey: "food", defaultClassification: "consumable", sortOrder: 0 } },
    { t: "addFolder", folder: { id: "f2", name: "Toiletries", colorKey: "other", defaultClassification: "base", sortOrder: 1 } },
    row("mon1", "Monday", { folderId: "f1", unitWeightMg: 0, description: "Meals", sortOrder: 0 }),
    row("risotto", "Mushroom Risotto", { folderId: "f1", parentId: "mon1", brand: "Good To-Go", commonName: "Dinner", unitWeightMg: 213000, entryUnit: "oz", kcal: 820, sortOrder: 0 }),
    row("mon2", "Monday", { folderId: "f1", unitWeightMg: 0, description: "Snacks", sortOrder: 1 }),
    row("bloks1", "Bloks Energy Chews", { folderId: "f1", parentId: "mon2", brand: "Clif", unitWeightMg: 60000, kcal: 200, sortOrder: 0 }),
    row("tue", "Tuesday", { folderId: "f1", unitWeightMg: 0, description: "Snacks", sortOrder: 2 }),
    row("bloks2", "Bloks Energy Chews", { folderId: "f1", parentId: "tue", brand: "Clif", unitWeightMg: 60000, qty: 2, kcal: 200, sortOrder: 0 }),
    row("paste", "Toothpaste", { folderId: "f2", commonName: "Toothpaste", unitWeightMg: 14000, sortOrder: 0 }),
    row("cream", "Moisturizer", { folderId: "f2", commonName: "Face moisturizer", unitWeightMg: 12000, description: "Travel *size*", sortOrder: 1 }),
    row("spoon", "Spoon", { unitWeightMg: 45359, sortOrder: 0 }),
  ]),

  // more names than a comment holds: the text names what fits, counts the rest, and
  // keeps its totals and link
  exportVector("long", [
    { t: "setMeta", patch: { title: "Everything" } },
    ...Array.from({ length: 160 }, (_, i) => row(`r${i}`, `Piece of gear number ${i + 1}`, { unitWeightMg: 10000 + i, sortOrder: i })),
  ]),
];

// ---- import vectors ----------------------------------------------------------------
// What csvToListData makes of a pasted or chosen file, for every shape it reads: our
// own CSV and Markdown, LighterPack's, spreadsheet cells, a semicolon CSV, a weight
// header that names its unit, a list typed one item per line, our plain-text copy.
// Written as data with no ids (a folder by its name, a group by its row's index), so
// the answer is the same on every run and readable in a diff.

const exportOf = (name: string) => exportVectors.find((v) => v.name === name)!.list;

const CSV_IMPORTS: [string, () => string][] = [
  ["ours-group-trip", () => listToCsv(exportOf("group-trip"))],
  ["ours-trip-notes", () => listToCsv(exportOf("trip-notes"))],
  ["ours-saved-by-a-spreadsheet", () => "\uFEFF" + listToCsv(exportOf("trip-notes")).replace(/\n/g, "\r\n")],
  ["markdown-trip-notes", () => listToMarkdown(exportOf("trip-notes"))],
  ["markdown-group-trip", () => listToMarkdown(exportOf("group-trip"))],
  ["markdown-any-table", () => ["## Shelter", "", "| Item | Weight (g) | Qty |", "|---|---:|---:|", "| Tent | 540 | 1 |", "| Stakes | 10 | 8 |"].join("\n")],
  ["plain-text-copy", () => listToText(exportOf("trip-notes"))],
  ["lighterpack", () => "Item Name,Category,desc,qty,weight,unit,price,worn,consumable,star,image url,url\nHyperlite 2400,Pack,Southwest,1,850,g,355,,,,,https://hmg.com\nPuffy,Worn,,1,10.6,oz,,1,,,,\nBars,Food,,5,68,g,,,1,,,"],
  ["spreadsheet-cells", () => "Category\tItem Name\tQty\tWeight\tUnit\nShelter\tQuilt 25F, Large\t1\t510\tg\nSleep\tPad\t1\t12\toz"],
  ["semicolons", () => "Category;Item Name;Qty;Weight;Unit\nShelter;Tent;1;1,2;kg\nSleep;Quilt;1;0,6;kg"],
  ["weight-header-oz", () => "Item,Weight (oz)\nTent,38\nQuilt,21"],
  ["weight-header-grams", () => "Item,Grams\nTent,1080"],
  ["weight-header-underscore", () => "Item,weight_g\nTent,1080"],
  ["unit-cell-over-header", () => "Item,Weight (oz),Unit\nTent,1080,g"],
  ["total-weight-is-not-weight", () => "Item,Total weight\nTent,1080"],
  ["weight-cell-units", () => "Item,Weight\nTent,21 oz\nStakes,1 lb 3 oz"],
  ["typed-notes", () => ["# Shelter", "- Tent 540 g", "- [ ] Stakes (85 g)", "Sleep:", "• Quilt 20 oz", "Socks ×2", "Water 2 L", "Headlamp"].join("\n")],
  ["typed-no-headings", () => "Tent 540 g\nQuilt 20 oz"],
  ["comma-run", () => "Zpacks Duplex tent, Quilt (20F, 600 g), Clif Bloks ×4, Water 3 L\n\nBase weight 3.16 kg, 7.65 kg total"],
  ["unknown-header", () => "thing,stuff\nSpork,18"],
  ["not-a-list", () => "not,a,list\n"],
  ["blank-category", () => "Category,Item Name,Weight\n,Loose,10\nShelter,Tent,540"],
];

function csvImportVector(name: string, text: string) {
  const data = csvToListData(text);
  const folderOf = new Map(data.folders.map((f) => [f.id, f.name]));
  const indexOf = new Map(data.items.map((it, i) => [it.id, i]));
  const personOf = new Map((data.people ?? []).map((p) => [p.id, p.name]));
  return {
    name,
    text,
    displayUnit: data.displayUnit ?? null,
    // read as typed text: the one shape in which the import box follows a pasted link
    typed: data.typed ?? false,
    folders: data.folders.map((f) => f.name),
    people: (data.people ?? []).map((p) => p.name),
    items: data.items.map((it) => ({
      folder: it.folderId ? (folderOf.get(it.folderId) ?? null) : null,
      parent: it.parentId ? (indexOf.get(it.parentId) ?? null) : null,
      name: it.name,
      brand: it.brand ?? null,
      commonName: it.commonName ?? null,
      qty: it.qty,
      wornQty: it.wornQty ?? null,
      unitWeightMg: it.unitWeightMg,
      entryUnit: it.entryUnit ?? null,
      classification: it.classification ?? null,
      kcal: it.kcal ?? null,
      description: it.description ?? null,
      productUrl: it.productUrl ?? null,
      person: it.personId ? (personOf.get(it.personId) ?? null) : null,
      needsCooking: it.needsCooking ?? null,
      sortOrder: it.sortOrder,
    })),
  };
}

// Spellings the catalog doesn't hold: a plural, a typed type, the long tail that
// goes without an icon, and the narrow names that sit above a broader rule.
const EXTRA_TYPES = [
  "  stuff   SACK ", "hiking boots", "Sporks", "Pouches", "Stuff sacks", "Compass", "Umbrella", "Whistle",
  "Packraft", "Ice axe", "Neck gaiter", "Bandana", "Gaiters", "Running vest", "Vest", "Fleece pants",
  "Bottle cap", "Stake bag", "Coffee filter", "Fuel bottle", "Tent poles", "Bug net", "Emergency blanket",
  "E-reader", "Hip belt", "Bungee cords", "Bungees", "Pee funnel", "Pill bottle", "Toiletry bottle",
  "Phone case", "Camera case", "Toothbrush case", "Pack liner", "Toiletry bag", "Face wipe", "Face wipes",
  "Fanny pack", "Keychain flashlight", "Mouth guard", "Card game", "Air pump",
  // a lens goes with the camera it mounts on; the ones worn in an eye do not
  "Lens", "Lenses", "Camera lens", "Contact lenses",
];

// A row with no gear type is read by its name instead.
const NAMES_WITHOUT_TYPE = [
  "Deodorant", "Relief Sun: Rice + Probiotics SPF50+", "Meals - Dinner", "Snacks - Daily",
  "Baggies Brimmer Hat", "Face cleanser + Face Moisturizer + Container", "Summit Pro Hat", "Hiker Boot Midweight",
  "Zpacks Duplex", "",
];

/** Every gear type the catalog holds, and the spellings above, each with its icon. */
export function glyphVectors() {
  const [head, ...rows] = parseCsv(readFileSync(CATALOG_CSV, "utf8"));
  const col = head.indexOf("common_name");
  const types = [...new Set([...rows.map((r) => r[col]).filter(Boolean), ...EXTRA_TYPES])].sort();
  return {
    types: types.map((type) => [type, gearGlyphFor(type)]),
    names: NAMES_WITHOUT_TYPE.map((name) => [name, gearGlyphFor(null, name)]),
    families: GEAR_GLYPHS.map((glyph) => [glyph, gearFamilyOf(glyph)]),
  };
}

// ---- rule vectors ------------------------------------------------------------------
// The port's pure rules that no op replays, because they run before an op exists (a
// typed number, a catalog pick), after one is stored (the read-time tidy) or around a
// whole list (a copy, a restored backup). The port had each of these and no vector for
// any, so the web changed four of them in a day with the iOS suite green. One file per
// rule in vectors/, each a list of cases answered here by the real function.

// A typed number, handed to every field that reads one (shared/typedNumber): the bare
// figures on which the fields once disagreed, then figures with a unit, a symbol or a
// sentence around them.
const TYPED_NUMBERS = [
  "1234", "820", "1.5", "0.5", ".9", "12.25", "1,5", "1,50", "12,50", "0,5", "1,23", "72,5",
  "1,234.56", "1.234,56", "1,234", "1,299", "2,000", "1,500", "3,159", "1 234", "12 000", "12 000",
  "1 234,5", "1 234.5", "1,234,567", "1.234.567", "1,2345", ",9", "0,750", "1234,567", "1.234", "0.250",
  "5 10", "1,2,3", "1..5", "-5", "", " ", "lots",
  "2,000 ml", "1,5 l", "12 000 g", "1,2345 kg", "2 lb 3 oz", "32.5 oz (921 g)",
  ",9 km", "7.5 mi • 3,159 ft • Out & back", "Out & back,12 km",
  "$1,299.00", "1.299,00 €", "CAD 12,50", "approx. $399",
  "250 kcal", "2.700 kcal", "1 350 calories", "250 kcal 3",
];

/** null for nothing read; a cell that is not a number reads NaN, which JSON has no word for */
const read = (n: number | null | undefined) => (n == null || Number.isNaN(n) ? null : n);

function typedNumberVector(input: string) {
  const price = parsePriceInput(input);
  return {
    input,
    weight: read(parseWeightInput(input, "g")), // milligrams, on a gram list
    cell: read(parseDecimal(input)), // a number cell in an imported file
    distance: read(parseDistanceM(input, "km")), // metres, on a km list
    water: read(parseVolumeMl(input)), // millilitres; a bare number is litres
    price: price?.cents ?? null,
    currency: price?.currency ?? null,
    kcal: read(parseKcal(input)),
    csvKcal: csvToListData(`name,weight,unit,calories,consumable\nBars,60,g,"${input}",1`).items[0]?.kcal ?? null,
    csvQty: csvToListData(`name,qty,weight,unit\nBars,"${input}",60,g`).items[0]?.qty ?? null,
  };
}

// What a row takes from the catalog product it is linked to (pickFromCatalog), on the
// points the copies it replaced disagreed: a consumable product's class, an equal kept
// weight, calories, and the gear type a row keeps (keptGearType).
const PICK_FOLDERS: Folder[] = [
  { id: "pack", name: "Pack", colorKey: "pack", defaultClassification: "base", sortOrder: 0 },
  { id: "food", name: "Food", colorKey: "food", defaultClassification: "consumable", sortOrder: 1 },
];
const TENT: CatalogPickRow = { id: 7, brand: "Zpacks", name: "Duplex", variant: "DCF", weightMg: 538000, commonName: "Tent", categoryHint: "shelter", kcal: null };
const BAR: CatalogPickRow = { id: 4, brand: "Clif", name: "Builders Bar", variant: null, weightMg: 68000, commonName: "Energy bar", categoryHint: "consumable", kcal: 290 };
const RICE: CatalogPickRow = { ...BAR, id: 5, brand: "Knorr", name: "Rice Sides", kcal: null };

/** One pick: the product, what the caller keeps, and the folder (of PICK_FOLDERS) the row sits in. */
function pickVector(name: string, catalog: CatalogPickRow, own: CatalogPickOwn, folderId: string | null) {
  return { name, catalog, own, folderId, patch: pickFromCatalog(catalog, own, { folderId, folders: PICK_FOLDERS }) };
}

/** A pick onto a row already on a list, keeping the gear type that row keeps. */
function rowPickVector(name: string, row: Pick<Item, "commonName" | "commonNameOverridden">) {
  return { ...pickVector(name, TENT, { commonName: keptGearType(row) }, "pack"), row };
}

const catalogPickVectors = () => [
  pickVector("nothing-kept", TENT, {}, "pack"),
  pickVector("no-brand-or-variant", { ...TENT, brand: null, variant: null, commonName: null }, {}, "pack"),
  pickVector("food-in-a-base-folder", BAR, {}, "pack"),
  pickVector("food-in-a-food-folder", BAR, {}, "food"),
  pickVector("food-in-no-folder", BAR, {}, null),
  pickVector("class-set-by-the-caller", BAR, { classification: null }, "pack"),
  pickVector("equal-weight-kept", TENT, { weightMg: 538000 }, "pack"),
  pickVector("other-weight-kept", TENT, { weightMg: 600000 }, "pack"),
  pickVector("name-kept-in-another-case", TENT, { name: "duplex" }, "pack"),
  pickVector("calories-kept", BAR, { kcal: 240 }, "food"),
  pickVector("no-calories-kept", BAR, { kcal: null }, "food"),
  pickVector("product-states-no-calories", RICE, {}, "food"),
  rowPickVector("gear-type-typed", { commonName: "Shelter", commonNameOverridden: true }),
  rowPickVector("gear-type-cleared", { commonNameOverridden: true }),
  rowPickVector("gear-type-from-the-last-product", { commonName: "Tarp" }),
];

// The read-time tidy (tidyStoredList), on a list as a build before the rules could
// have left it. No fixture reaches this: every one of those gets its state through ops,
// and no op can store these values any more. So the list is made through ops and then
// set back by hand.
function storedTidyVector() {
  const stored = freshState();
  applyOps(stored, [
    { t: "setMeta", patch: { title: "Trip", description: "Plan", trailUrl: "https://example.com/trail", trailLabel: "Loop" } },
    { t: "addFolder", folder: { id: "f1", name: "Kit", colorKey: "pack", defaultClassification: "base", sortOrder: 0 } },
    { t: "addPerson", person: { id: "p1", name: "Sam", sortOrder: 0 } },
    row("text", "Tent", { brand: "Zpacks", variant: "DCF", commonName: "Tent", description: "note" }),
    row("blank", "Pot", { brand: "Toaks", variant: "750", commonName: "Pot", description: "lid", sortOrder: 1 }),
    row("water", "Bottle", { unitWeightMg: 1000000, qty: 3, classification: "consumable", sortOrder: 2 }),
    row("split", "Flask", { unitWeightMg: 500000, qty: 2, wornQty: 1, classification: "base", sortOrder: 3 }),
    row("gear", "Water bottle", { qty: 2, sortOrder: 4 }),
  ]);
  const item = (id: string) => stored.items.find((i) => i.id === id)!;
  stored.title = "  Ryan's  trip ";
  stored.description = "Sam's plan\n\n  two  nights ";
  stored.trailLabel = "   ";
  stored.folders[0]!.name = "  ";
  stored.people![0]!.name = "";
  // straight quotes and stray spaces, from before text was tidied on the way in
  Object.assign(item("text"), { name: "Ryan's  tent", brand: " Zpacks", variant: 'DCF 2"', commonName: "Tent ", description: "Sam's  spare" });
  // blank where a cleared field is now absent
  Object.assign(item("blank"), { brand: "", variant: "  ", commonName: "", description: "" });
  // a count on water, from before it folded into the volume, and a split of that count
  item("water").name = "Water";
  item("split").name = "Drinking water";
  return { name: "stored-under-older-rules", stored, tidied: canonical(tidyStoredList(structuredClone(stored))) };
}

// A copy (cloneListData) and a restored backup (jsonToListImport) of a list with a
// route: the route comes along, every pin is kept, and there is one trailhead and one
// finish, where a route end kept by id used to come back doubled. Both mint new ids, so
// a case states the pins without theirs; `backup` is the file as the web writes it.
function routeCopyVector(name: string, ops: Op[]) {
  const list = freshState();
  applyOps(list, ops);
  const backup = listToJson(list);
  const restored = jsonToListImport(backup)!;
  const pins = (waypoints: Waypoint[] | undefined) => (waypoints ?? []).map(({ id: _minted, ...pin }) => pin);
  return {
    name,
    list,
    backup,
    cloned: { routeGeometry: pickListMeta(list).routeGeometry, waypoints: pins(cloneListData(list).waypoints) },
    restored: { routeGeometry: restored.routeGeometry, waypoints: pins(restored.data.waypoints) },
  };
}

const routeCopyVectors = () => [
  routeCopyVector("open-route", [
    { t: "setMeta", patch: { title: "Timberline", routeGeometry: openRoute } },
    { t: "addWaypoint", waypoint: { id: "w1", kind: "water", alongM: 900, label: "spring" } },
    { t: "addWaypoint", waypoint: { id: "w2", kind: "camp", alongM: 1600, note: "flat spots" } },
  ]),
  // a loop has one pin for both ends, and keeps having one
  routeCopyVector("loop", [
    { t: "setMeta", patch: { routeGeometry: loopRoute } },
    { t: "addWaypoint", waypoint: { id: "w1", kind: "water", alongM: 700 } },
  ]),
];

/** Each rule's cases, by the name of the file they are written to in vectors/. */
export function ruleVectors(): Record<string, { cases: unknown[]; folders?: Folder[] }> {
  return {
    "typed-numbers": { cases: TYPED_NUMBERS.map(typedNumberVector) },
    "catalog-picks": { folders: PICK_FOLDERS, cases: catalogPickVectors() },
    "stored-tidy": { cases: [storedTidyVector()] },
    "route-copies": { cases: routeCopyVectors() },
    "csv-imports": { cases: CSV_IMPORTS.map(([name, text]) => csvImportVector(name, text())) },
  };
}
