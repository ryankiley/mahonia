// FIT — the binary file a watch or bike computer records in, read the way its neighbours
// in gpx.ts read theirs: in the browser, never uploaded.
//
// A FIT file is a 12- or 14-byte header (".FIT" at bytes 8–11 is the signature this is
// sniffed by), a run of RECORDS, then a two-byte CRC. A record is either a DEFINITION
// message, which binds a local message type (0–15) to a global message number and an
// ordered list of (field number, size, base type), or a DATA message, whose bytes are laid
// out exactly as the definition sharing its local type said. Definitions apply in order,
// so the same local type can be redefined mid-file. A data message may instead wear a
// COMPRESSED TIMESTAMP header (high bit set): five bits of time offset, which this reader
// never needs, and only two bits of local type.
//
// What this reads is one message: global 20, `record`, the per-second sample every
// activity and every course file is made of. Its position is two signed 32-bit
// SEMICIRCLES (2^31 to 180°), its altitude a uint16 in fifths of a metre offset by 500
// (field 2) or a uint32 the same way (field 78, `enhanced_altitude`, which wins when both
// are present). A sample with no fix carries the base type's invalid value and is skipped,
// as is every message that isn't a record. Course files also carry `course_point`
// (global 32): the named stops a planner placed. Those come back as pins, the way a GPX's
// <wpt> does, for the caller to OFFER rather than apply; the cues among them (turns,
// distance markers, category climbs, hazards, a gel reminder) are left out, since a route
// with sixty "turn left" pins is not a route anyone reads.
//
// Hand-rolled rather than a dependency for the reason the KMZ reader is: this chunk is
// loaded on demand, the format is small once you want only one message, and nothing in
// the read path should be a library that could grow a network call. The CRC is not
// checked: a corrupt file yields coordinates the bounds check rejects, and a file a watch
// was still writing when the cable came out has no CRC yet, and its header still says 0
// data bytes. Chained files (several concatenated, which some devices emit) are read end
// to end. Anything malformed ends the read at the first record that can't be followed,
// keeping what came before it, rather than throwing.
//
// Cost is linear in the bytes. A definition names where the few fields worth reading sit,
// so a data message is a handful of fixed-offset reads whatever its field count; a
// hostile file full of 255-field messages costs no more per byte than a real one.

import { validLatLon } from "./polyline";
import type { FilePin, TrackPoint } from "./gpx";
import { filledElevations } from "./profile";
import { MAX_WAYPOINTS } from "./ops";

/** degrees per semicircle: the format stores 180° as 2^31 */
const SEMICIRCLE_DEG = 180 / 2 ** 31;
const RECORD = 20;
/** a course file's header message, which carries the course's name */
const COURSE = 31;
const COURSE_POINT = 32;
/** the header's signature: ".FIT" at bytes 8–11 */
const SIGNATURE = [0x2e, 0x46, 0x49, 0x54];
/**
 * A course file can carry a point per metre; the offer is "N marked places, add them?",
 * and nobody wants that question about a thousand. The first list's-worth, in file
 * order — a list holds MAX_WAYPOINTS, so decoding more than that is work for an offer
 * that could never be taken up.
 */
export const MAX_FIT_PINS = MAX_WAYPOINTS;

interface FieldDef {
  num: number;
  size: number;
  /** the base type, by the low five bits of its byte */
  base: number;
}
/** where one field of interest sits inside a data message */
interface Slot {
  at: number;
  f: FieldDef;
}
interface Definition {
  global: number;
  littleEndian: boolean;
  /** the whole data message, developer fields included */
  size: number;
  lat?: Slot;
  lon?: Slot;
  altitude?: Slot;
  enhanced?: Slot;
  name?: Slot;
  type?: Slot;
}

/**
 * The course-point types that are PLACES, with the word the pin's kind is read from
 * (shared/gpx pinKind, the same rule a GPX <sym> goes through). Everything not listed is
 * a cue rather than a place. The numbers are the FIT profile's `course_point` enum.
 */
const PLACE_TYPES: Record<number, string> = {
  0: "generic",
  1: "summit",
  2: "valley",
  3: "water",
  4: "food",
  5: "danger",
  9: "first aid",
  27: "campsite",
  28: "aid station",
  29: "rest area",
  31: "service",
  35: "checkpoint",
  36: "shelter",
  37: "meeting spot",
  38: "overlook",
  39: "toilet",
  40: "shower",
  41: "gear",
  48: "store",
  51: "transport",
  53: "info",
};

/** Whether the first twelve bytes of a file are a FIT header. */
export function isFit(head: Uint8Array): boolean {
  return head.length >= 12 && SIGNATURE.every((b, i) => head[8 + i] === b);
}

export interface FitRoute {
  points: TrackPoint[];
  pins: FilePin[];
  /** a course's name (the course message's field 5); an activity file has none */
  name?: string;
}

/**
 * The track and the placed points out of a FIT file, in file order. Empty for anything
 * that isn't one, partial for a file that ends early, never a throw. Takes the bytes as
 * they come, a whole buffer or a view into one (a zip member).
 */
export function fitRoute(data: ArrayBuffer | Uint8Array): FitRoute {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: FitRoute = { points: [], pins: [] };
  let at = 0;
  // one file after another, each with its own header: a chained file is just this loop
  // going round twice, and each round starts with no definitions
  while (at + 12 <= bytes.length && isFit(bytes.subarray(at, at + 12))) {
    const headerSize = bytes[at]!;
    if (headerSize < 12) break;
    const dataSize = view.getUint32(at + 4, true);
    const dataStart = at + headerSize;
    // The header says how many data bytes follow, and a file still being written says 0.
    // Then EVERYTHING left is read as data, CRC included if one is there: a two-byte tail
    // can never make a point (a position alone is eight bytes), so it costs nothing to
    // look at, and stopping two bytes early would lose the end of the last real record
    // in exactly the file that has no CRC. Either way, never past what we were given.
    const end = dataSize > 0 ? Math.min(bytes.length, dataStart + dataSize) : bytes.length;
    readRecords(view, bytes, dataStart, end, out);
    at = end + 2; // over the CRC
  }
  fillAltitude(out.points);
  return out;
}

/** Walk one file's records, definitions and data alike, until the end or the first record
 *  that can't be followed. */
function readRecords(view: DataView, bytes: Uint8Array, start: number, end: number, out: FitRoute): void {
  const defs: (Definition | undefined)[] = [];
  let at = start;
  while (at < end) {
    const header = bytes[at]!;
    at += 1;
    // compressed timestamp: the local type is bits 5–6, the offset (bits 0–4) is time
    const compressed = header & 0x80;
    const local = compressed ? (header >> 5) & 0x03 : header & 0x0f;
    if (!compressed && header & 0x40) {
      // a definition: reserved byte, architecture, global number, field count, fields
      if (at + 5 > end) return;
      const littleEndian = bytes[at + 1] === 0;
      const global = view.getUint16(at + 2, littleEndian);
      const count = bytes[at + 4]!;
      at += 5;
      if (at + count * 3 > end) return;
      const def: Definition = { global, littleEndian, size: 0 };
      for (let i = 0; i < count; i++) {
        const f: FieldDef = { num: bytes[at]!, size: bytes[at + 1]!, base: bytes[at + 2]! & 0x1f };
        const slot = { at: def.size, f };
        // the profile's field numbers for the two messages worth reading; every other
        // field, and every field of every other message, only contributes its width
        if (global === RECORD) {
          if (f.num === 0) def.lat = slot;
          else if (f.num === 1) def.lon = slot;
          else if (f.num === 2) def.altitude = slot;
          else if (f.num === 78) def.enhanced = slot;
        } else if (global === COURSE) {
          if (f.num === 5 && f.base === 0x07) def.name = slot;
        } else if (global === COURSE_POINT) {
          if (f.num === 2) def.lat = slot;
          else if (f.num === 3) def.lon = slot;
          else if (f.num === 5) def.type = slot;
          else if (f.num === 6 && f.base === 0x07) def.name = slot;
        }
        def.size += f.size;
        at += 3;
      }
      if (header & 0x20) {
        // developer fields: (number, size, developer data index) each. They widen the
        // data message and are never read, so only the size is kept.
        if (at + 1 > end) return;
        const devCount = bytes[at]!;
        at += 1;
        if (at + devCount * 3 > end) return;
        for (let i = 0; i < devCount; i++) {
          def.size += bytes[at + 1]!;
          at += 3;
        }
      }
      defs[local] = def;
      continue;
    }
    const def = defs[local];
    // a data message before any definition of its type: the stream can't be followed
    if (!def || at + def.size > end) return;
    readData(view, bytes, at, def, out);
    at += def.size;
  }
}

/** One data message. Only a record or a course point with a position has anything for us. */
function readData(view: DataView, bytes: Uint8Array, at: number, def: Definition, out: FitRoute): void {
  if (def.global === COURSE) {
    // a course planned on Garmin Connect, Komoot or Ride with GPS arrives named
    if (def.name && !out.name) out.name = readString(bytes, at + def.name.at, def.name.f.size);
    return;
  }
  if (!def.lat || !def.lon) return;
  const le = def.littleEndian;
  const lat = readNumber(view, at + def.lat.at, def.lat.f, le);
  const lon = readNumber(view, at + def.lon.at, def.lon.f, le);
  if (lat == null || lon == null) return;
  const latDeg = lat * SEMICIRCLE_DEG;
  const lonDeg = lon * SEMICIRCLE_DEG;
  // a longitude can't overflow (2^31 semicircles IS 180°, and the count past it is the
  // invalid value), but a latitude can: the same range reaches 180° where 90° is the pole
  if (!validLatLon(latDeg, lonDeg)) return;
  if (def.global === RECORD) {
    // fifths of a metre, offset by 500 so that sea level is not the invalid value
    const raw =
      (def.enhanced && readNumber(view, at + def.enhanced.at, def.enhanced.f, le)) ??
      (def.altitude && readNumber(view, at + def.altitude.at, def.altitude.f, le));
    const ele = raw == null ? undefined : raw / 5 - 500;
    out.points.push(ele == null ? { lat: latDeg, lon: lonDeg } : { lat: latDeg, lon: lonDeg, ele });
    return;
  }
  if (out.pins.length >= MAX_FIT_PINS) return;
  // a course point that says no type is a generic place; one that says a cue is left out
  const type = def.type ? readNumber(view, at + def.type.at, def.type.f, le) : undefined;
  const place = type == null ? "generic" : PLACE_TYPES[type];
  if (place == null) return;
  const name = def.name ? readString(bytes, at + def.name.at, def.name.f.size) : undefined;
  out.pins.push({ lat: latDeg, lon: lonDeg, name, sym: place });
}

/**
 * Carry a known altitude across the samples that lack one — the rule gpxStats applies
 * to every format (filledElevations has the why), written back onto the points here
 * because a FIT's points are read by callers before they reach gpxStats. A track with
 * no altitude anywhere is left as it is.
 */
function fillAltitude(points: TrackPoint[]): void {
  const ele = filledElevations(points);
  if (ele.length) points.forEach((p, i) => (p.ele = ele[i]));
}

/**
 * A field's first value, or undefined when the field holds its base type's INVALID
 * value — which is how the format says "no reading": a sample without a fix writes
 * 0x7FFFFFFF into its position rather than omitting the field. A field wider than its
 * base type is an array, and its first element is the one that answers for it.
 *
 * Only the base types the profile gives the fields read here. A file that declares one
 * of them as anything else has no reading for it: a position that isn't semicircles
 * would otherwise be scaled as if it were, and land as a wrong place on the map.
 */
function readNumber(view: DataView, at: number, f: FieldDef, le: boolean): number | undefined {
  const read = (width: number, get: () => number, invalid: number) => {
    if (f.size < width || at + width > view.byteLength) return undefined;
    const v = get();
    return v === invalid ? undefined : v;
  };
  switch (f.base) {
    case 0x00: // enum: a course point's type
    case 0x02: // uint8
      return read(1, () => view.getUint8(at), 0xff);
    case 0x04: // uint16: altitude
      return read(2, () => view.getUint16(at, le), 0xffff);
    case 0x05: // sint32: a position, in semicircles
      return read(4, () => view.getInt32(at, le), 0x7fffffff);
    case 0x06: // uint32: enhanced altitude
      return read(4, () => view.getUint32(at, le), 0xffffffff);
    default:
      return undefined;
  }
}

/** one decoder for every name, not one per course point */
const UTF8 = new TextDecoder();

/** A null-terminated UTF-8 string in a field of `size` bytes; undefined when blank. */
function readString(bytes: Uint8Array, at: number, size: number): string | undefined {
  const raw = bytes.subarray(at, Math.min(bytes.length, at + size));
  const nul = raw.indexOf(0);
  const text = UTF8.decode(nul >= 0 ? raw.subarray(0, nul) : raw).trim();
  return text || undefined;
}
