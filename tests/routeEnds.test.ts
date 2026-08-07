import { describe, expect, it } from "vitest";
import { encodePolyline, LOOP_CLOSE_M } from "~~/shared/polyline";
import { seedRouteEnds } from "~~/shared/ops";

/**
 * A route arrives with its own two ends. These run on both sides of the wire — the reducer
 * seeds them on the client optimistically and again on the server authoritatively — so the
 * ids have to be FIXED, or the same pin gets two identities and the merge keeps both.
 */
const line = (pts: [number, number][]) => encodePolyline(pts.map(([lat, lon]) => ({ lat, lon })));

describe("seedRouteEnds", () => {
  it("gives an out-and-back a start and a finish", () => {
    const wps = seedRouteEnds(line([[45.33, -121.71], [45.38, -121.69], [45.42, -121.64]]));
    expect(wps.map((w) => w.kind)).toEqual(["trailhead", "end"]);
    expect(wps[0]!.alongM).toBe(0);
    expect(wps[1]!.alongM).toBeGreaterThan(0);
  });

  it("gives a LOOP one pin, not two stacked on the same spot", () => {
    const wps = seedRouteEnds(line([[45.33, -121.71], [45.38, -121.69], [45.42, -121.64], [45.33, -121.71]]));
    expect(wps.map((w) => w.kind)).toEqual(["trailhead"]);
  });

  it("counts a finish within the loop threshold as the same place", () => {
    // ~11 m north of the start — well inside LOOP_CLOSE_M, so still one pin
    expect(LOOP_CLOSE_M).toBeGreaterThan(11);
    const wps = seedRouteEnds(line([[45.33, -121.71], [45.38, -121.69], [45.3301, -121.71]]));
    expect(wps).toHaveLength(1);
  });

  it("uses fixed ids, so client and server seed the SAME pins", () => {
    const geo = line([[45.33, -121.71], [45.42, -121.64]]);
    expect(seedRouteEnds(geo).map((w) => w.id)).toEqual(seedRouteEnds(geo).map((w) => w.id));
    expect(seedRouteEnds(geo)[0]!.id).toBe("wp-start");
  });

  it("seeds nothing without a route", () => {
    expect(seedRouteEnds("")).toEqual([]);
  });
});
