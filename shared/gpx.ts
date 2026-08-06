// GPX — reading a route file the browser already has.
//
// The file never leaves the device. There is no upload and no request: `File.text()` and
// `DOMParser`, both built in. That isn't only a privacy nicety — the site's CSP is
// `connect-src 'self'`, so sending it anywhere is not an option that exists, and the
// claim "your file stays in your browser" is therefore literally true rather than a
// promise. No XML dependency either; the bundle budget's whole argument forbids one.
//
// What this does NOT do is take over the route's numbers. It fills the distance and climb
// fields in for confirmation and the typed values stay the source of truth — a mangled
// track can't silently rewrite a route somebody entered by hand. Same conservatism
// trailLink.ts applies to names.
//
// LOADED ON DEMAND. Everything here runs once, when somebody picks a file, so ListHead
// reaches it through `await import()` and none of it lands on the first load of a plain
// packing list. The arithmetic the reducer and the charts need — parsing a stored profile,
// climbs per day, grade bands — lives in profile.ts precisely so this file can stay off
// that path. Import FROM profile.ts freely; never make profile.ts import from here.
import { ASCENT_THRESHOLD_M, PROFILE_SAMPLES, SMOOTH_WINDOW, smooth } from "./profile";

/** One point off the track. `ele` is often absent — plenty of tracks carry no elevation. */
export interface TrackPoint {
  lat: number;
  lon: number;
  ele?: number;
}

export interface GpxStats {
  distanceM: number;
  ascentM: number;
  descentM: number;
  minEleM: number;
  maxEleM: number;
  /** elevations sampled evenly BY DISTANCE — see resampleByDistance */
  profile: number[];
  pointCount: number;
}

/** Refuse rather than block the main thread for seconds on a huge track. */
export const MAX_GPX_BYTES = 10_000_000;

const EARTH_R_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance between two points, in metres. */
export function haversineM(a: TrackPoint, b: TrackPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Track points out of a parsed GPX document, in file order.
 *
 * Both `trkpt` and `rtept`: a planned route is a `rte` and a recorded one is a `trk`, and
 * someone dropping a file in has no reason to care which they exported.
 */
export function gpxPoints(doc: Document): TrackPoint[] {
  // GPX first, then the other XML dialects that carry the same thing under other names.
  // A route is a route; which app exported it is not the walker's problem.
  const kml = kmlPoints(doc);
  if (kml.length) return kml;
  const tcx = tcxPoints(doc);
  if (tcx.length) return tcx;
  const georss = georssPoints(doc);
  if (georss.length) return georss;
  const nodes = [...byLocalName(doc, "trkpt"), ...byLocalName(doc, "rtept")];
  const out: TrackPoint[] = [];
  for (const n of nodes) {
    const lat = Number(n.getAttribute("lat"));
    const lon = Number(n.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const eleText = localText(n, "ele");
    const ele = eleText != null ? Number(eleText) : Number.NaN;
    out.push(Number.isFinite(ele) ? { lat, lon, ele } : { lat, lon });
  }
  return out;
}

/**
 * Elements by LOCAL name, ignoring any namespace prefix.
 *
 * `querySelectorAll("line")` does not match `<georss:line>` in an XML document — a CSS
 * type selector matches the qualified name, and a prefixed element doesn't have the one
 * you asked for. Plenty of real files prefix their elements (`kml:coordinates`,
 * `georss:line`), so every reader below goes through this rather than through a selector
 * that happens to work on whichever export you tried first.
 */
function byLocalName(doc: Document, name: string): Element[] {
  const want = name.toLowerCase();
  return [...doc.getElementsByTagName("*")].filter((el) => el.localName.toLowerCase() === want);
}

/** The text of the first descendant with this local name. */
function localText(el: Element, name: string): string | null {
  const want = name.toLowerCase();
  for (const child of el.getElementsByTagName("*")) {
    if (child.localName.toLowerCase() === want) return child.textContent;
  }
  return null;
}

/**
 * KMZ — a KML in a zip, which is what Google Earth saves by default.
 *
 * Unzipped here rather than with a library: `DecompressionStream` is built into the
 * browser, so this costs no dependency and, more to the point, keeps the promise the rest
 * of this file makes. A zip library would be the first thing in the read path that isn't
 * a built-in, and "your file never leaves your browser" is only worth saying while nothing
 * in the chain could send it anywhere.
 *
 * Reads the CENTRAL DIRECTORY rather than the local headers. A local header is allowed to
 * carry zeroes for the sizes and defer them to a data descriptor after the payload, which
 * is exactly what streaming zip writers emit — parsing those first would work on files
 * made by one tool and fail on another. The central directory always has the real numbers.
 */
export async function kmzToKml(buffer: ArrayBuffer): Promise<string | null> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null; // not "PK"

  // End of central directory, scanned backwards — it sits at the end, after a comment
  // whose length nothing else tells us.
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= 0 && i > buffer.byteLength - 65_557; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) return null;
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (!/\.kml$/i.test(name)) continue;

    // the local header repeats the name and extra fields at its own lengths
    if (view.getUint32(localAt, true) !== 0x04034b50) return null;
    const dataAt =
      localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    const payload = bytes.subarray(dataAt, dataAt + compressed);
    if (method === 0) return new TextDecoder().decode(payload); // stored
    if (method !== 8) return null; // anything but deflate is beyond what a KMZ should be
    const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return await new Response(stream).text();
  }
  return null;
}

/**
 * GeoRSS, which wraps a track in a feed. Coordinates are a flat, space-separated
 * `lat lon lat lon …` run inside `<georss:line>` or `<georss:polygon>` — LAT first here,
 * the opposite of KML, which is the sort of detail that makes a silent mess of a route.
 */
function georssPoints(doc: Document): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const node of [...byLocalName(doc, "line"), ...byLocalName(doc, "polygon")]) {
    const nums = (node.textContent ?? "").trim().split(/[\s,]+/).map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const lat = nums[i]!;
      const lon = nums[i + 1]!;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      out.push({ lat, lon });
    }
  }
  return out;
}

/**
 * KML / Google Earth. Coordinates arrive as whitespace-separated `lon,lat[,ele]` triples
 * inside `<coordinates>`, which is the one thing about this format worth knowing: the
 * order is LON FIRST, the opposite of every other format here and of how anybody says it.
 *
 * Only the coordinates belonging to a LINE are read. A KML carries `<coordinates>` for
 * every placemark in the document, and a real export is full of them: AllTrails' Timberline
 * file has twelve blocks — the 3,483-point track, and eleven single-point markers for
 * trailheads and features. Concatenating all twelve stitched each marker into the route and
 * turned a 39.8-mile loop into 58.5, which is the kind of wrong that looks plausible.
 *
 * Several LineStrings ARE joined, because a KML track is often split into segments — the
 * same concession gpxPoints makes for multi-segment tracks. A `<Point>` never is.
 */
function kmlPoints(doc: Document): TrackPoint[] {
  const out: TrackPoint[] = [];
  const LINES = new Set(["linestring", "linearring", "track"]);
  for (const block of byLocalName(doc, "coordinates")) {
    // a marker's coordinates hang off <Point>; only a line's are route geometry
    if (!LINES.has(block.parentElement?.localName.toLowerCase() ?? "")) continue;
    for (const triple of (block.textContent ?? "").trim().split(/\s+/)) {
      if (!triple) continue;
      const [lon, lat, ele] = triple.split(",").map(Number);
      if (!Number.isFinite(lat!) || !Number.isFinite(lon!)) continue;
      out.push(Number.isFinite(ele!) ? { lat: lat!, lon: lon!, ele: ele! } : { lat: lat!, lon: lon! });
    }
  }
  return out;
}

/**
 * TCX / Garmin Training Center. Lat and lon are child ELEMENTS rather than attributes, and
 * elevation is `<AltitudeMeters>` — the same data as a GPX trackpoint wearing longer names.
 */
function tcxPoints(doc: Document): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const n of byLocalName(doc, "Trackpoint")) {
    const lat = Number(localText(n, "LatitudeDegrees"));
    const lon = Number(localText(n, "LongitudeDegrees"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const ele = Number(localText(n, "AltitudeMeters"));
    out.push(Number.isFinite(ele) ? { lat, lon, ele } : { lat, lon });
  }
  return out;
}

/**
 * GeoJSON, which is JSON rather than XML and so never reaches a DOMParser.
 *
 * Reads LineString and MultiLineString, and the geometry inside a Feature or a
 * FeatureCollection — the four shapes a route is realistically exported as. Positions are
 * `[lon, lat, ele?]`, lon first again.
 *
 * Refuses rather than salvages, like everything else that takes a file here: a member that
 * isn't a pair of finite numbers is skipped, and a document with no recognisable geometry
 * yields nothing rather than a partial line.
 */
export function geoJsonPoints(raw: unknown): TrackPoint[] {
  const out: TrackPoint[] = [];
  const addLine = (coords: unknown) => {
    if (!Array.isArray(coords)) return;
    for (const pos of coords) {
      if (!Array.isArray(pos)) continue;
      const [lon, lat, ele] = pos as number[];
      if (typeof lat !== "number" || typeof lon !== "number") continue;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out.push(typeof ele === "number" && Number.isFinite(ele) ? { lat, lon, ele } : { lat, lon });
    }
  };
  const walk = (node: unknown, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    const n = node as Record<string, unknown>;
    if (n.type === "LineString") addLine(n.coordinates);
    else if (n.type === "MultiLineString" && Array.isArray(n.coordinates)) n.coordinates.forEach(addLine);
    if (n.geometry) walk(n.geometry, depth + 1);
    if (Array.isArray(n.features)) n.features.forEach((f) => walk(f, depth + 1));
    if (Array.isArray(n.geometries)) n.geometries.forEach((g) => walk(g, depth + 1));
  };
  walk(raw);
  return out;
}

/**
 * Resample elevations evenly along the DISTANCE walked, not along the point index.
 *
 * Point density is inversely proportional to speed — a recorder logging every second puts
 * far more points on a slow climb than on a fast descent. Sampling by index therefore
 * compresses the climbs and stretches the descents: it draws the wrong mountain.
 */
function resampleByDistance(
  cumulative: number[],
  elevations: number[],
  samples: number,
): number[] {
  const total = cumulative[cumulative.length - 1] ?? 0;
  if (!(total > 0) || elevations.length < 2) return [];
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < samples; i++) {
    const target = (total * i) / (samples - 1);
    while (j < cumulative.length - 2 && cumulative[j + 1]! < target) j++;
    const d0 = cumulative[j]!;
    const d1 = cumulative[j + 1]!;
    const span = d1 - d0;
    const f = span > 0 ? (target - d0) / span : 0;
    out.push(Math.round(elevations[j]! + (elevations[j + 1]! - elevations[j]!) * f));
  }
  return out;
}

/**
 * Distance, climb and a profile from a track. Null when there isn't enough to say
 * anything — one point is a location, not a route.
 *
 * Distance is 2D. Slope-correcting it would inflate the figure against every trail sign
 * and every other tool, and on real terrain the difference is under 1%.
 */
export function gpxStats(points: readonly TrackPoint[]): GpxStats | null {
  if (points.length < 2) return null;

  const cumulative: number[] = [0];
  let distanceM = 0;
  for (let i = 1; i < points.length; i++) {
    distanceM += haversineM(points[i - 1]!, points[i]!);
    cumulative.push(distanceM);
  }
  if (!(distanceM > 0)) return null;

  const withEle = points.every((p) => p.ele != null)
    ? (points as TrackPoint[]).map((p) => p.ele!)
    : [];

  let ascentM = 0;
  let descentM = 0;
  let minEleM = 0;
  let maxEleM = 0;
  let profile: number[] = [];

  if (withEle.length) {
    minEleM = Math.min(...withEle);
    maxEleM = Math.max(...withEle);
    // Hysteresis: `reference` is the last elevation we committed a change from. A move is
    // only real once it clears the threshold, and then the reference jumps to it — so a
    // long steady climb still accumulates fully, while jitter around a level never does.
    const eased = smooth(withEle, SMOOTH_WINDOW);
    let reference = eased[0]!;
    for (const ele of eased) {
      const delta = ele - reference;
      if (delta >= ASCENT_THRESHOLD_M) {
        ascentM += delta;
        reference = ele;
      } else if (delta <= -ASCENT_THRESHOLD_M) {
        descentM += -delta;
        reference = ele;
      }
    }
    profile = resampleByDistance(cumulative, withEle, PROFILE_SAMPLES);
  }

  return {
    distanceM: Math.round(distanceM),
    ascentM: Math.round(ascentM),
    descentM: Math.round(descentM),
    minEleM: Math.round(minEleM),
    maxEleM: Math.round(maxEleM),
    profile,
    pointCount: points.length,
  };
}
