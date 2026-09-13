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
import { CLIMB_SAMPLE_M, PROFILE_SAMPLES, totalClimb } from "./profile";
import { MAX_WAYPOINTS } from "./ops";
import type { WaypointKind } from "./types";

// The one binary format, in its own file for legibility and re-exported here so the
// composable's single `await import()` still fetches every reader as one chunk.
export { fitRoute, isFit, MAX_FIT_PINS, type FitRoute } from "./fit";

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

/**
 * A route can only hold this many waypoints. Keep a file's optional pin offer within
 * that same bound before it reaches the reactive editor or projection loop.
 */
export const MAX_FILE_PINS = MAX_WAYPOINTS;

const EARTH_R_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Coordinates outside the Earth are malformed input, not an unusual route. */
function validLatLon(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/**
 * XML attributes and element text have a dangerous coercion edge: `Number(null)`
 * and `Number("")` are both 0. A missing coordinate is not a point on the Gulf of
 * Guinea, so blank text stays NaN and falls through the ordinary finite/range gate.
 */
function finiteTextNumber(raw: string | null | undefined): number {
  const text = raw?.trim();
  if (!text) return Number.NaN;
  const n = Number(text);
  return Number.isFinite(n) ? n : Number.NaN;
}

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
    const lat = finiteTextNumber(n.getAttribute("lat"));
    const lon = finiteTextNumber(n.getAttribute("lon"));
    if (!validLatLon(lat, lon)) continue;
    const ele = finiteTextNumber(localText(n, "ele"));
    out.push(Number.isFinite(ele) ? { lat, lon, ele } : { lat, lon });
  }
  return out;
}

/** A pin the file already carried, before it is projected onto the route. */
export interface FilePin {
  lat: number;
  lon: number;
  name?: string;
  /** the exporter's own category — `<sym>` in GPX, the KML placemark's style id */
  sym?: string;
}

/**
 * What a pin's words mean, case-folded and matched loosely.
 *
 * Deliberately a SUBSTRING match, because there is no registry: `<sym>` is free text and
 * every exporter writes its own. Real values for one idea include "Water Source", "water",
 * "Drinking Water" and "spring", and matching whole strings would recognise almost none of
 * them.
 *
 * Order matters — first hit wins — and the specific sits above the general, or "trailhead
 * parking" lands on the parking rule when it should land on the trailhead one. Anything
 * unrecognised becomes a landmark rather than being dropped: the position is the part that
 * was hard to come by, and the kind is one tap to correct.
 */
const PIN_KINDS: [RegExp, WaypointKind][] = [
  [/trail\s*head/, "trailhead"],
  // `lodging`, NOT `lodge` — measured against the real Timberline export, where the route
  // starts at Timberline Lodge. A named lodge is a building you walk past or start from,
  // and calling it a campsite is a confident wrong answer where "landmark" is a quiet
  // right-enough one.
  [/camp|tent|shelter|hut|lodging|bivou?ac/, "camp"],
  [/water|spring|drink|well|creek|stream|faucet|spigot/, "water"],
  [/parking|car\s*park|trail\s*lot/, "trailhead"],
];

/**
 * Whether a `sym` is this pin's category or just a list of every category the exporter has.
 *
 * AllTrails' KML writes `styleUrl` as the WHOLE enumeration — a single string reading
 * `#generic,summit,valley,mountainpass,water,food,danger,firstaid,…` on every placemark,
 * identically. A substring match against that says "water" for every pin on the route,
 * confidently and wrongly, which is worse than saying nothing.
 *
 * So a value naming several categories at once is treated as naming none of them. The
 * numbers are loose on purpose: a genuine sym is one or two words ("Water Source",
 * "Campground"), and nothing legitimate needs four commas.
 */
const looksEnumerated = (s: string) => s.length > 40 || (s.match(/,/g)?.length ?? 0) >= 3;

/**
 * A pin's kind, from whatever the file gave us.
 *
 * `sym` first when it is a real per-pin value, then the NAME — and the name matters more
 * than it looks. The exporter people actually use writes no `<sym>` at all in GPX and an
 * enumeration in KML, so on real files the name is the only signal there is: "Good Camp
 * Area", "Elk Cove Camp" and "Cairn Basin Shelter" are all obviously camps to a reader and
 * would otherwise all arrive as landmarks.
 */
export function pinKind(pin: Pick<FilePin, "sym" | "name">): WaypointKind {
  const sym = (pin.sym ?? "").toLowerCase();
  if (sym && !looksEnumerated(sym)) {
    for (const [re, kind] of PIN_KINDS) if (re.test(sym)) return kind;
  }
  const name = (pin.name ?? "").toLowerCase();
  if (name) {
    for (const [re, kind] of PIN_KINDS) if (re.test(name)) return kind;
  }
  return "landmark";
}

/**
 * The pins a file carries, which are NOT the track.
 *
 * A `<wpt>` is a sibling of `<trk>`, not part of it — which is exactly why gpxPoints reads
 * `trkpt`/`rtept` and never `wpt`. Reading them into the route was a real bug earlier on
 * this branch: a KML export's twelve marker placemarks inflated a 39.8-mile trail to 58.5,
 * because a pin off in a car park is a coordinate but not a step anyone walks.
 *
 * So they come back separately, and the caller decides. They stay OFF by default, and only
 * the first MAX_FILE_PINS valid pins are retained: a file can carry thousands, but a list
 * cannot hold more than its waypoint limit.
 */
export function filePins(doc: Document): FilePin[] {
  const out: FilePin[] = [];
  for (const n of byLocalName(doc, "wpt")) {
    if (out.length >= MAX_FILE_PINS) break;
    const lat = finiteTextNumber(n.getAttribute("lat"));
    const lon = finiteTextNumber(n.getAttribute("lon"));
    if (!validLatLon(lat, lon)) continue;
    out.push({
      lat,
      lon,
      name: localText(n, "name")?.trim() || undefined,
      sym: localText(n, "sym")?.trim() || undefined,
    });
  }
  if (out.length) return out;
  // KML says the same thing with a Placemark holding a Point. Only those — a Placemark
  // wrapping a LineString is the ROUTE, and picking it up here would put a pin on it.
  for (const pm of byLocalName(doc, "Placemark")) {
    if (out.length >= MAX_FILE_PINS) break;
    const point = [...pm.getElementsByTagName("*")].find((el) => el.localName.toLowerCase() === "point");
    if (!point) continue;
    const raw = localText(point, "coordinates")?.trim();
    const [rawLon, rawLat] = (raw ?? "").split(",");
    const lon = finiteTextNumber(rawLon);
    const lat = finiteTextNumber(rawLat);
    if (!validLatLon(lat, lon)) continue;
    out.push({
      lat,
      lon,
      name: localText(pm, "name")?.trim() || undefined,
      sym: localText(pm, "styleUrl")?.trim() || undefined,
    });
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

/** One file out of a zip: its name as the archive spells it, and its bytes, inflated. */
export interface ZipMember {
  name: string;
  bytes: Uint8Array;
}

/** Inflate a deflate member without ever buffering more route data than we accept. */
async function inflateDeflateRaw(payload: Uint8Array<ArrayBuffer>, maxBytes: number): Promise<Uint8Array | null> {
  try {
    const reader = new Blob([payload]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The first member of a zip whose name `want` accepts, unpacked. Null for anything that
 * isn't a zip, holds no such member, or packs it some way other than stored or deflate.
 *
 * Two files arrive this way: a KMZ, which is a KML in a zip and what Google Earth saves
 * by default, and the "Export Original" a Garmin Connect activity offers, which is the
 * watch's own FIT in a zip. Both are unzipped here rather than with a library:
 * `DecompressionStream` is built into the browser, so this costs no dependency and, more
 * to the point, keeps the promise the rest of this file makes. A zip library would be the
 * first thing in the read path that isn't a built-in, and "your file never leaves your
 * browser" is only worth saying while nothing in the chain could send it anywhere.
 *
 * Reads the CENTRAL DIRECTORY rather than the local headers. A local header is allowed to
 * carry zeroes for the sizes and defer them to a data descriptor after the payload, which
 * is exactly what streaming zip writers emit — parsing those first would work on files
 * made by one tool and fail on another. The central directory always has the real numbers.
 */
export async function zipMember(buffer: ArrayBuffer, want: (name: string) => boolean): Promise<ZipMember | null> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (buffer.byteLength > MAX_GPX_BYTES || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null; // not "PK"
  const inBounds = (at: number, length: number) =>
    Number.isSafeInteger(at) && at >= 0 && Number.isSafeInteger(length) && length >= 0 && at <= bytes.length - length;

  // End of central directory, scanned backwards — it sits at the end, after a comment
  // whose length nothing else tells us.
  let eocd = -1;
  // ZIP permits a 65,535-byte comment, so its EOCD can sit exactly 65,557 bytes
  // from the end (22-byte record + comment). Include that lower endpoint.
  const firstEocd = Math.max(0, buffer.byteLength - 65_557);
  for (let i = buffer.byteLength - 22; i >= firstEocd; i--) {
    // A comment is arbitrary bytes, including the EOCD magic. Its own declared
    // length is the only proof that a candidate is really the final record.
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === buffer.byteLength
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i++) {
    if (!inBounds(at, 46)) return null; // fixed central-directory header
    if (view.getUint32(at, true) !== 0x02014b50) return null;
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const uncompressed = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const entryLength = 46 + nameLen + extraLen + commentLen;
    if (!inBounds(at, entryLength)) return null;
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += entryLength;
    if (!want(name)) continue;

    // A KMZ can have huge previews or attachments beside its route. We never read
    // those members, so their declared size must not reject an otherwise sound KML.
    // The selected member still has both its compressed and inflated size bounded.
    if (compressed > MAX_GPX_BYTES || uncompressed > MAX_GPX_BYTES) return null;

    // the local header repeats the name and extra fields at its own lengths
    if (!inBounds(localAt, 30)) return null;
    if (view.getUint32(localAt, true) !== 0x04034b50) return null;
    const dataAt =
      localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    if (!inBounds(dataAt, compressed)) return null;
    const payload = bytes.subarray(dataAt, dataAt + compressed);
    if (method === 0) return { name, bytes: payload }; // stored
    if (method !== 8) return null; // anything but deflate is beyond what these zips should be
    const inflated = await inflateDeflateRaw(payload, MAX_GPX_BYTES);
    return inflated ? { name, bytes: inflated } : null;
  }
  return null;
}

/** KMZ — the KML inside, as text. */
export async function kmzToKml(buffer: ArrayBuffer): Promise<string | null> {
  const member = await zipMember(buffer, (name) => /\.kml$/i.test(name));
  return member ? new TextDecoder().decode(member.bytes) : null;
}

/**
 * GeoRSS, which wraps a track in a feed. Coordinates are a flat, space-separated
 * `lat lon lat lon …` run inside `<georss:line>` or `<georss:polygon>` — LAT first here,
 * the opposite of KML, which is the sort of detail that makes a silent mess of a route.
 */
function georssPoints(doc: Document): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const node of [...byLocalName(doc, "line"), ...byLocalName(doc, "polygon")]) {
    const tokens = (node.textContent ?? "").trim().split(/[\s,]+/);
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const lat = finiteTextNumber(tokens[i]);
      const lon = finiteTextNumber(tokens[i + 1]);
      if (!validLatLon(lat, lon)) continue;
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
      const [rawLon, rawLat, rawEle] = triple.split(",");
      const lon = finiteTextNumber(rawLon);
      const lat = finiteTextNumber(rawLat);
      const ele = finiteTextNumber(rawEle);
      if (!validLatLon(lat, lon)) continue;
      out.push(Number.isFinite(ele) ? { lat, lon, ele } : { lat, lon });
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
    const lat = finiteTextNumber(localText(n, "LatitudeDegrees"));
    const lon = finiteTextNumber(localText(n, "LongitudeDegrees"));
    if (!validLatLon(lat, lon)) continue;
    // Number(null) is 0, so an absent altitude must be kept distinct from a
    // genuine sea-level reading. Otherwise one incomplete TCX point invents a
    // descent to sea level and makes the whole profile look measured.
    const ele = finiteTextNumber(localText(n, "AltitudeMeters"));
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
      if (!validLatLon(lat, lon)) continue;
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
function resampleByDistance(cumulative: number[], elevations: number[]): number[] {
  const samples = PROFILE_SAMPLES;
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
 * The elevation every `stepM` along the track, interpolated between samples, ending on
 * the track's last reading so the final stretch counts. The measuring-grade cousin of
 * resampleByDistance above: the same walk along the cumulative distances, but at a
 * spacing rather than a count, and unrounded, because this series is measured and never
 * stored.
 */
function resampleEvery(cumulative: number[], elevations: number[], stepM: number): number[] {
  const total = cumulative[cumulative.length - 1] ?? 0;
  const out: number[] = [];
  let j = 0;
  for (let target = 0; target < total; target += stepM) {
    while (j < cumulative.length - 2 && cumulative[j + 1]! < target) j++;
    const d0 = cumulative[j]!;
    const span = cumulative[j + 1]! - d0;
    const f = span > 0 ? (target - d0) / span : 0;
    out.push(elevations[j]! + (elevations[j + 1]! - elevations[j]!) * f);
  }
  out.push(elevations[elevations.length - 1]!);
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
  if (points.length < 2 || points.some((p) => !validLatLon(p.lat, p.lon))) return null;

  const cumulative: number[] = [0];
  let distanceM = 0;
  for (let i = 1; i < points.length; i++) {
    distanceM += haversineM(points[i - 1]!, points[i]!);
    cumulative.push(distanceM);
  }
  if (!(distanceM > 0)) return null;

  const withEle = points.every((p) => typeof p.ele === "number" && Number.isFinite(p.ele))
    ? (points as TrackPoint[]).map((p) => p.ele!)
    : [];

  let ascentM = 0;
  let descentM = 0;
  let minEleM = 0;
  let maxEleM = 0;
  let profile: number[] = [];

  if (withEle.length) {
    // a loop, not Math.min(...withEle): spreading a long track's elevations into a call
    // overflows the argument list somewhere past a hundred thousand points, which a
    // watch reaches in a day and a half of recording
    minEleM = withEle[0]!;
    maxEleM = withEle[0]!;
    for (const e of withEle) {
      if (e < minEleM) minEleM = e;
      if (e > maxEleM) maxEleM = e;
    }
    // Smoothed and thresholded rather than summed — profile.ts owns that pairing and the
    // calibration behind it. Measured across the FULL track here, which is the whole
    // reason the figure is stored separately from the resampled profile below: the
    // resampling smooths away real undulation, so it draws well and measures badly.
    //
    // …on a series no denser than the filter was calibrated for (CLIMB_SAMPLE_M, and the
    // note there). A track sampled every second is resampled to that spacing first; a
    // sparser one is measured as it is, since interpolating it finer would only undo the
    // smoothing its exporter already did.
    const dense = distanceM / (withEle.length - 1) < CLIMB_SAMPLE_M;
    ({ ascentM, descentM } = totalClimb(dense ? resampleEvery(cumulative, withEle, CLIMB_SAMPLE_M) : withEle));
    profile = resampleByDistance(cumulative, withEle);
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
