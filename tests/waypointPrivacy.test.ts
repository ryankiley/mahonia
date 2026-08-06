import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rowToSnapshot } from "../server/utils/listRepo";
import { listToJson } from "../shared/exporters/json";
import { encodePolyline } from "../shared/polyline";
import type { ListRow } from "../server/db/schema";
import type { ListData, ListMeta } from "../shared/types";

// The route's shape is the app's only stored geography, and it is not public.
//
// `trailProfile` is 240 elevation numbers with no position in them — genuinely anonymous
// terrain. A route is not the same object: a recorded track starts where the person
// parked, which is frequently where they live. And a waypoint is only a distance, which
// discloses nothing alone — but combined with the geometry it resolves to a precise point,
// so the two are ONE privacy object and travel together or not at all. Note the list also
// carries its dates, which makes a published camp pin a statement about where a named
// person will be sleeping on a given night.
//
// The protection is architectural: rowToSnapshot omits both, so every read path starts
// without them and has to ask. That is the wrong way round from how it reads, and it is
// the only shape that fails CLOSED — /s, /l and the public feed all build on
// rowToSnapshot, and so will any read path added later.
//
// This file asserts BOTH halves, because the last time the app had a wrapper like this
// only the "doesn't leak" half was tested, and THREE owner paths quietly forgot to call
// it — including the autosave echo, which emptied the field on every save.

const ROOT = new URL("..", import.meta.url).pathname;
const GEOMETRY = encodePolyline([
  { lat: 45.33, lon: -121.71 },
  { lat: 45.34, lon: -121.7 },
]);

const row = (over: Partial<ListRow> = {}) =>
  ({
    id: 1,
    publicSlug: "trip-a1b2c3",
    editTokenHash: "hash",
    shareCode: "ABC123",
    title: "Trip",
    description: null,
    displayUnit: "g",
    trailUrl: null,
    trailLabel: null,
    trailDistanceM: 12_070,
    trailDistanceUnit: "km",
    trailProfile: "1000,1200,1100",
    trailAscentM: 500,
    trailDescentM: 400,
    routeGeometry: GEOMETRY,
    startDate: null,
    endDate: null,
    data: {
      folders: [],
      items: [],
      days: [],
      waypoints: [{ id: "w1", kind: "camp", alongM: 6_200, label: "Cairn Basin" }],
    },
    baseWeightMg: 0,
    wornWeightMg: 0,
    consumableWeightMg: 0,
    totalWeightMg: 0,
    itemCount: 0,
    isPublic: false,
    version: 1,
    updatedAt: new Date("2026-08-06T00:00:00Z"),
    ...over,
  }) as unknown as ListRow;

describe("a route never rides a read path", () => {
  it("rowToSnapshot omits the geometry and empties the waypoints", () => {
    const snap = rowToSnapshot(row());
    expect("routeGeometry" in snap).toBe(false);
    expect(snap.waypoints).toEqual([]);
    // …while the rest of the trail meta IS there, so this isn't passing by accident
    expect(snap.trailDistanceM).toBe(12_070);
    expect(snap.trailProfile).toBe("1000,1200,1100");
  });

  it("survives serialization — no coordinate, no label, no distance-along", () => {
    // JSON.stringify is what actually reaches a browser, and a present-but-undefined key
    // vanishes there too; `in` above catches the weaker version of the fix.
    const json = JSON.stringify(rowToSnapshot(row()));
    expect(json).not.toContain(GEOMETRY);
    expect(json).not.toContain("Cairn Basin");
    expect(json).not.toContain("6200");
  });

  it("the days beside them are still public, which is the point of the asymmetry", () => {
    const snap = rowToSnapshot(
      row({ data: { folders: [], items: [], days: [{ id: "d1", sortOrder: 0, distanceM: 16_093 }], waypoints: [] } } as Partial<ListRow>),
    );
    expect(snap.days).toHaveLength(1);
  });

  it("stays out of a JSON backup taken from a PUBLIC snapshot", () => {
    // /s and /l do offer "Download JSON", and it runs on the public snapshot — so the
    // exporter carrying geometry deliberately is safe by construction, not by care
    const publicSnap = rowToSnapshot(row()) as unknown as ListMeta & ListData;
    const json = listToJson(publicSnap);
    expect(json).not.toContain(GEOMETRY);
    expect(json).not.toContain("Cairn Basin");
  });
});

describe("…but the OWNER still gets it back", () => {
  const src = readFileSync(`${ROOT}server/utils/listRepo.ts`, "utf8");

  // every function that answers an edit token or mints a list — i.e. talks to an owner
  const OWNER_PATHS = [
    "getByEditToken",
    "createList",
    "applyOpsByEditToken",
    "restoreSnapshotByEditToken",
  ];

  const bodyOf = (name: string) => {
    const start = src.search(new RegExp(`(export )?(async )?function ${name}\\b`));
    expect(start, `${name} not found in listRepo.ts`).toBeGreaterThan(-1);
    const rest = src.slice(start + 1);
    const end = rest.search(/\n(export )?(async )?function /);
    return end === -1 ? rest : rest.slice(0, end);
  };

  it.each(OWNER_PATHS)("%s carries the owner-only fields", (name) => {
    const body = bodyOf(name);
    expect(body).toContain("rowToSnapshot");
    expect(body).toContain("withOwnerOnly");
  });

  it("and withOwnerOnly is the only thing that ever sets them", () => {
    // If a second place starts assigning these, the guarantee stops being one line and
    // becomes a habit. Exactly two assignments, both inside the wrapper.
    expect(src.match(/\.routeGeometry\s*=/g) ?? []).toHaveLength(1);
    expect(src.match(/snap\.waypoints\s*=/g) ?? []).toHaveLength(1);
  });

  it("a restore WRITES the geometry, unlike the field this wrapper replaced", () => {
    // Body weight was deliberately not written on restore, because it never entered the
    // chain. Geometry is the opposite case: it rides the chain, it is the one field an
    // owner cannot retype, and omitting the write would NULL it on every restore — the
    // exact bug trailProfile already had.
    expect(bodyOf("restoreSnapshotByEditToken")).toMatch(/routeGeometry:\s*s\.routeGeometry/);
  });

  it("normalizeListData carries waypoints, or a restore drops every one", () => {
    // the reconstructed data passes through here on its way to the row
    expect(src).toMatch(/waypoints\.sort/);
    expect(src).toMatch(/return \{ folders, items, days, waypoints \}/);
  });
});
