import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { filePins, gpxPoints, pinKind } from "../shared/gpx";
import {
  LOOP_CLOSE_M,
  cumulativeM,
  decodePolyline,
  isLoop,
  nearestAlongM,
  routeGeometryFromPoints,
} from "../shared/polyline";
import { applyOps, type Op } from "../shared/ops";
import type { ListState } from "../shared/types";

// The pins a route file carries, and the two every route has anyway.
//
// Read against the REAL AllTrails exports rather than fixtures, because every interesting
// thing here is a fact about what real exporters actually write, and a fixture is just a
// restatement of what I already believed. Two of these assertions exist only because the
// real files disagreed with me: AllTrails writes no <sym> at all in GPX, and writes its
// entire style enumeration as the KML styleUrl.
//
// `text/html`, not `application/xml`: happy-dom's XML parser errors on these files' CDATA,
// which real browsers parse without complaint — the app has imported all of them.
const HOME = process.env.HOME ?? "";
const parser = new (new Window().DOMParser)();
const parse = (t: string) => parser.parseFromString(t, "text/html") as unknown as Document;
const read = (name: string) => parse(readFileSync(`${HOME}/Downloads/${name}`, "utf8"));

// The real exports live on the machine that has them, not in the repo — they are 300 KB
// to 1.2 MB each and they are somebody's files, not fixtures. So the checks that need them
// run where they exist and skip where they don't, rather than being replaced by a synthetic
// track that would only restate what I already assumed. Everything below that is pure
// arithmetic runs everywhere.
const REAL_FILES = ["Timberline_Trail_600.gpx", "Timberline_Trail_600.kml", "Wildwood_Trail.gpx"];
const haveReal = REAL_FILES.every((f) => existsSync(`${HOME}/Downloads/${f}`));
const withRealFiles = describe.skipIf(!haveReal);

const state = (over: Partial<ListState> = {}): ListState => ({
  title: "T",
  description: "",
  displayUnit: "g",
  folders: [],
  items: [],
  days: [],
  waypoints: [],
  version: 0,
  ...over,
});

withRealFiles("a route's own two ends, on the real exports", () => {
  it("Timberline closes on itself, so it gets ONE end marker", () => {
    // A loop's start and finish are the same car park. A second pin there sits on top of
    // the first and reads as a rendering fault rather than as a fact about the walk.
    expect(isLoop(gpxPoints(read("Timberline_Trail_600.gpx")))).toBe(true);
  });

  it("Wildwood does not, so it gets two", () => {
    expect(isLoop(gpxPoints(read("Wildwood_Trail.gpx")))).toBe(false);
  });

});

describe("loop detection", () => {
  it("the threshold is loose on purpose", () => {
    // A there-and-back that doubles the last stretch of trail, and a track that reacquired
    // a few paces from where it started, should both read as "you finish where you began".
    const a = { lat: 45.33, lon: -121.71 };
    const near = { lat: 45.33 + 30 / 111_320, lon: -121.71 };
    const far = { lat: 45.33 + 300 / 111_320, lon: -121.71 };
    expect(isLoop([a, { lat: 45.4, lon: -121.8 }, near])).toBe(true);
    expect(isLoop([a, { lat: 45.4, lon: -121.8 }, far])).toBe(false);
    expect(LOOP_CLOSE_M).toBeGreaterThanOrEqual(25);
  });
});

withRealFiles("what the exporters actually write", () => {
  it("the GPX carries pins that are NOT part of the track", () => {
    const doc = read("Timberline_Trail_600.gpx");
    const track = gpxPoints(doc);
    const pins = filePins(doc);
    expect(pins.length).toBe(11);
    expect(track.length).toBeGreaterThan(3000);
    // the miles the route measures must be unaffected by the pins existing — this is the
    // bug that read a 39.8-mile trail as 58.5 by treating markers as steps
    const miles = cumulativeM(track).at(-1)! / 1609.34;
    expect(miles).toBeGreaterThan(39);
    expect(miles).toBeLessThan(41);
  });

  it("the KML's pins come from Placemark/Point, never from its LineString", () => {
    const doc = read("Timberline_Trail_600.kml");
    const pins = filePins(doc);
    expect(pins.length).toBe(11);
    expect(pins.map((p) => p.name)).toContain("Cairn Basin Shelter");
    const miles = cumulativeM(gpxPoints(doc)).at(-1)! / 1609.34;
    expect(miles).toBeGreaterThan(39);
    expect(miles).toBeLessThan(41);
  });

  it("every pin projects onto the line at a sane chainage, in route order", () => {
    const doc = read("Timberline_Trail_600.kml");
    const line = decodePolyline(routeGeometryFromPoints(gpxPoints(doc))!);
    const total = cumulativeM(line).at(-1)!;
    const along = filePins(doc).map((p) => nearestAlongM(line, p));
    for (const m of along) {
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(total);
    }
    // the file lists them in walking order, and projection must preserve that
    expect([...along].sort((a, b) => a - b)).toEqual(along);
    // Timberline Lodge is the start; Cloud Cap is most of the way round
    expect(along[0]! / 1609.34).toBeLessThan(0.5);
    expect(along.at(-1)! / 1609.34).toBeGreaterThan(25);
  });
});

describe("naming a pin's kind", () => {
  it("reads the NAME, because the real exporter gives nothing else", () => {
    // AllTrails writes no <sym> in GPX at all. Without the name fallback every pin on a
    // real route arrives as a landmark.
    expect(pinKind({ name: "Good Camp Area" })).toBe("camp");
    expect(pinKind({ name: "Elk Cove Camp" })).toBe("camp");
    expect(pinKind({ name: "Cairn Basin Shelter" })).toBe("camp");
    expect(pinKind({ name: "Wy East Basin Meadow with Good Campsites" })).toBe("camp");
    expect(pinKind({ name: "Viewpoint" })).toBe("landmark");
    expect(pinKind({ name: "Ramona Falls" })).toBe("landmark");
  });

  it("a lodge is not a campsite", () => {
    // The real Timberline route starts AT Timberline Lodge. `lodge` in the camp pattern
    // made the trailhead a campsite; `lodging` is what was meant.
    expect(pinKind({ name: "Timberline Lodge" })).toBe("landmark");
    expect(pinKind({ sym: "Lodging" })).toBe("camp");
  });

  it("ignores a sym that lists every category the exporter has", () => {
    // AllTrails' KML writes this IDENTICAL string as styleUrl on every placemark. Matched
    // as a substring it says "water" for every pin on the route — confidently, and wrongly.
    const enumerated =
      "#generic,summit,valley,mountainpass,water,food,danger,firstaid,sprint,straight,left,parking,campingground";
    expect(pinKind({ sym: enumerated, name: "Viewpoint" })).toBe("landmark");
    expect(pinKind({ sym: enumerated, name: "Elk Cove Camp" })).toBe("camp");
    // …while a genuine one-word sym is still trusted over the name
    expect(pinKind({ sym: "Water Source", name: "Unnamed" })).toBe("water");
  });

  it("prefers the specific over the general", () => {
    expect(pinKind({ sym: "trailhead parking" })).toBe("trailhead");
    expect(pinKind({ sym: "Parking Area" })).toBe("trailhead");
    expect(pinKind({ sym: "Drinking Water" })).toBe("water");
    expect(pinKind({})).toBe("landmark");
  });
});

describe("pins belong to the route they were placed on", () => {
  const A = routeGeometryFromPoints([
    { lat: 45.33, lon: -121.71 },
    { lat: 45.34, lon: -121.7 },
    { lat: 45.35, lon: -121.69 },
  ])!;
  const B = routeGeometryFromPoints([
    { lat: 47.6, lon: -122.3 },
    { lat: 47.61, lon: -122.29 },
    { lat: 47.62, lon: -122.28 },
  ])!;
  const withPins: Op[] = [
    { t: "setMeta", patch: { routeGeometry: A } },
    { t: "addWaypoint", waypoint: { id: "w1", kind: "camp", alongM: 500 } },
  ];

  it("a NEW route drops the old pins rather than re-pointing them", () => {
    // "Water at 6.2 miles" describes one route and describes nothing on another. Carried
    // over, it silently means whatever is now 6.2 miles in — which looks exactly like a
    // pin somebody placed.
    const s = applyOps(state(), [...withPins, { t: "setMeta", patch: { routeGeometry: B } }]);
    expect(s.waypoints!.some((w) => w.id === "w1")).toBe(false);
    expect(s.routeGeometry).toBe(B);
    // What IS there is the new route's own two ends, seeded by the same branch that
    // cleared the old pins — so this asserts the placed pin is gone, not that the list is
    // empty, which stopped being the same statement when routes started arriving with ends.
    expect(s.waypoints!.map((w) => w.id)).toEqual(["wp-start", "wp-end"]);
  });

  it("clearing the route clears them too", () => {
    const s = applyOps(state(), [...withPins, { t: "setMeta", patch: { routeGeometry: "" } }]);
    expect(s.waypoints).toEqual([]);
    expect("routeGeometry" in s).toBe(false);
  });

  it("but re-saving the SAME route keeps them", () => {
    // The geometry rides ordinary setMeta patches, so an unconditional clear would empty
    // the pins on any autosave that happened to carry it.
    const s = applyOps(state(), [...withPins, { t: "setMeta", patch: { routeGeometry: A } }]);
    expect(s.waypoints!.some((w) => w.id === "w1")).toBe(true);
  });

  it("and a patch that says nothing about the route leaves them alone", () => {
    const s = applyOps(state(), [...withPins, { t: "setMeta", patch: { title: "Renamed" } }]);
    expect(s.waypoints!.some((w) => w.id === "w1")).toBe(true);
  });
});
