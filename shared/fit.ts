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

import type { FilePin, TrackPoint } from "./gpx";
import { MAX_WAYPOINTS } from "./ops";

/** degrees per semicircle: the format stores 180° as 2^31 */
const SEMICIRCLE_DEG = 180 / 2 ** 31;
const RECORD = 20;
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

/** The width of each base type, by the low five bits of its byte. */
const BASE_SIZE: Record<number, number> = {
  0x00: 1, // enum
  0x01: 1, // sint8
  0x02: 1, // uint8
  0x03: 2, // sint16
  0x04: 2, // uint16
  0x05: 4, // sint32
  0x06: 4, // uint32
  0x07: 1, // string
  0x08: 4, // float32
  0x09: 8, // float64
  0x0a: 1, // uint8z
  0x0b: 2, // uint16z
  0x0c: 4, // uint32z
  0x0d: 1, // byte
  0x0e: 8, // sint64
  0x0f: 8, // uint64
  0x10: 8, // uint64z
};

interface FieldDef {
  num: number;
  size: number;
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
    if (header & 0x80) {
      // compressed timestamp: the local type is bits 5–6, the offset (bits 0–4) is time
      const def = defs[(header >> 5) & 0x03];
      if (!def || at + def.size > end) return;
      readData(view, bytes, at, def, out);
      at += def.size;
      continue;
    }
    const local = header & 0x0f;
    if (header & 0x40) {
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
  if (!def.lat || !def.lon) return;
  const le = def.littleEndian;
  const lat = readNumber(view, at + def.lat.at, def.lat.f, le);
  const lon = readNumber(view, at + def.lon.at, def.lon.f, le);
  if (lat == null || lon == null) return;
  const latDeg = lat * SEMICIRCLE_DEG;
  const lonDeg = lon * SEMICIRCLE_DEG;
  // a longitude can't overflow (2^31 semicircles IS 180°, and the count past it is the
  // invalid value), but a latitude can: the same range reaches 180° where 90° is the pole
  if (Math.abs(latDeg) > 90 || Math.abs(lonDeg) > 180) return;
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
 * Carry a known altitude across the samples that lack one.
 *
 * A watch often has a fix a few seconds before its barometer has settled, and those
 * samples carry a valid position with the invalid altitude. gpxStats reads a track as
 * having elevation only when every point does, so a handful of such seconds would drop
 * the whole profile and the climb with it. Filled from the nearest earlier reading, and
 * the first later one for a leading gap, which is what the device's own screen shows in
 * those seconds. A track with no altitude anywhere is left as it is.
 */
function fillAltitude(points: TrackPoint[]): void {
  const first = points.find((p) => p.ele != null);
  if (!first) return;
  let last = first.ele!;
  for (const p of points) {
    if (p.ele == null) p.ele = last;
    else last = p.ele;
  }
}

/**
 * A field's first value, or undefined when the field holds its base type's INVALID
 * value — which is how the format says "no reading": a sample without a fix writes
 * 0x7FFFFFFF into its position rather than omitting the field. A field wider than its
 * base type is an array, and its first element is the one that answers for it.
 */
function readNumber(view: DataView, at: number, f: FieldDef, le: boolean): number | undefined {
  const width = BASE_SIZE[f.base];
  if (width == null || f.size < width || at + width > view.byteLength) return undefined;
  switch (f.base) {
    case 0x00: // enum
    case 0x02: // uint8
    case 0x0d: {
      // byte
      const v = view.getUint8(at);
      return v === 0xff ? undefined : v;
    }
    case 0x0a: {
      const v = view.getUint8(at);
      return v === 0 ? undefined : v;
    }
    case 0x01: {
      const v = view.getInt8(at);
      return v === 0x7f ? undefined : v;
    }
    case 0x03: {
      const v = view.getInt16(at, le);
      return v === 0x7fff ? undefined : v;
    }
    case 0x04: {
      const v = view.getUint16(at, le);
      return v === 0xffff ? undefined : v;
    }
    case 0x0b: {
      const v = view.getUint16(at, le);
      return v === 0 ? undefined : v;
    }
    case 0x05: {
      const v = view.getInt32(at, le);
      return v === 0x7fffffff ? undefined : v;
    }
    case 0x06: {
      const v = view.getUint32(at, le);
      return v === 0xffffffff ? undefined : v;
    }
    case 0x0c: {
      const v = view.getUint32(at, le);
      return v === 0 ? undefined : v;
    }
    case 0x08: {
      const v = view.getFloat32(at, le);
      return Number.isFinite(v) ? v : undefined;
    }
    case 0x09: {
      const v = view.getFloat64(at, le);
      return Number.isFinite(v) ? v : undefined;
    }
    case 0x0e: {
      const v = view.getBigInt64(at, le);
      return v === BigInt("0x7fffffffffffffff") ? undefined : Number(v);
    }
    case 0x0f: {
      const v = view.getBigUint64(at, le);
      return v === BigInt("0xffffffffffffffff") ? undefined : Number(v);
    }
    case 0x10: {
      const v = view.getBigUint64(at, le);
      return v === BigInt(0) ? undefined : Number(v);
    }
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
