// A duplicate keeps the route its source was planned on, and that route has one start and
// one finish. The copy's pins are sent with fresh ids beside the geometry they are
// measured along, so this runs the copy the way it crosses the wire: the request body the
// duplicate flow builds, through JSON, into the server's create.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { LISTS_DDL, SNAPSHOTS_DDL } from "../server/utils/db";
import { applyOpsByEditHash, createList, getByEditHash } from "../server/utils/listRepo";
import { sha256Hex } from "../server/utils/tokens";
import { cloneListData } from "../shared/clone";
import { encodePolyline } from "../shared/polyline";
import { pickListMeta, type Waypoint } from "../shared/types";
import { createTestDb } from "./helpers/db";
import { dbState } from "./helpers/dbMock";

vi.mock("../server/utils/db", async (o) => (await import("./helpers/dbMock")).mockDbModule(o));

const GEOMETRY = encodePolyline([
  { lat: 45.33, lon: -121.71 },
  { lat: 45.36, lon: -121.68 },
  { lat: 45.4, lon: -121.6 },
]);

/** The list's pins in route order, as "kind@metres". */
const pins = (list: { waypoints?: Waypoint[] }) =>
  [...(list.waypoints ?? [])].sort((a, b) => a.alongM - b.alongM).map((w) => `${w.kind}@${w.alongM}`);

describe("a duplicate of a list with a route", () => {
  beforeAll(async () => {
    dbState.db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
  });

  it("is stored with the route, one trailhead and one finish", async () => {
    const made = await createList({ title: "Timberline" });
    const hash = sha256Hex(made.editToken);
    await applyOpsByEditHash(hash, [
      { t: "setMeta", patch: { routeGeometry: GEOMETRY } },
      { t: "addWaypoint", waypoint: { id: "spring", kind: "water", alongM: 1_500 } },
    ]);
    const source = (await getByEditHash(hash))!;
    expect(pins(source).map((pin) => pin.split("@")[0])).toEqual(["trailhead", "water", "end"]);

    const body = JSON.parse(
      JSON.stringify({ ...pickListMeta(source), title: "Timberline (copy)", data: cloneListData(source) }),
    );
    const created = await createList(body);
    const copy = (await getByEditHash(sha256Hex(created.editToken)))!;

    expect(copy.routeGeometry).toBe(source.routeGeometry);
    expect(pins(copy)).toEqual(pins(source));
    const sourceIds = new Set(source.waypoints!.map((w) => w.id));
    expect(copy.waypoints!.filter((w) => sourceIds.has(w.id))).toEqual([]);
  });
});
