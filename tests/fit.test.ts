import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { fitRoute, isFit, MAX_FIT_PINS } from "../shared/fit";
import { gpxPoints, gpxStats, pinKind, zipMember } from "../shared/gpx";

// A FIT file is built here byte by byte, the way the KMZ tests build a real zip, so the
// decoder is exercised against the format and not against a mock of itself. The three
// Mount Hood points are the ones every other format's fixture carries (tests/gpx.test.ts),
// and the first claim below is the one that matters: a watch's file lands on the same
// TrackPoint[] as a GPX of the same walk.

const parser = new (new Window().DOMParser)();
const xml = (s: string) => parser.parseFromString(s, "application/xml") as unknown as Document;
const GPX = `<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><trk><trkseg>
  <trkpt lat="45.33" lon="-121.71"><ele>1800</ele></trkpt>
  <trkpt lat="45.34" lon="-121.70"><ele>1850</ele></trkpt>
  <trkpt lat="45.35" lon="-121.69"><ele>1900</ele></trkpt>
</trkseg></trk></gpx>`;
const HOOD: [number, number, number][] = [
  [45.33, -121.71, 1800],
  [45.34, -121.7, 1850],
  [45.35, -121.69, 1900],
];

// ---- a minimal FIT encoder ------------------------------------------------------------
type Base = "enum" | "uint8" | "sint32" | "uint16" | "uint32" | "string" | "float32";
const BASE: Record<Base, { code: number; size: number }> = {
  enum: { code: 0x00, size: 1 },
  uint8: { code: 0x02, size: 1 },
  uint16: { code: 0x84, size: 2 },
  sint32: { code: 0x85, size: 4 },
  uint32: { code: 0x86, size: 4 },
  string: { code: 0x07, size: 1 },
  float32: { code: 0x88, size: 4 },
};
interface Field { num: number; base: Base; size?: number }
const SEMI = 2 ** 31 / 180;
const semicircles = (deg: number) => Math.round(deg * SEMI);
const INVALID_SINT32 = 0x7fffffff;
/** altitude as the format stores it: fifths of a metre, offset by 500 */
const alt16 = (m: number) => (m + 500) * 5;

const cat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** A definition message for `local`, binding it to `global` with these fields. */
function definition(local: number, global: number, fields: Field[], opts: { bigEndian?: boolean; dev?: number[] } = {}): Uint8Array {
  const le = !opts.bigEndian;
  const head = new Uint8Array(6 + fields.length * 3);
  const dv = new DataView(head.buffer);
  head[0] = 0x40 | (opts.dev ? 0x20 : 0) | local;
  head[1] = 0; // reserved
  head[2] = le ? 0 : 1; // architecture
  dv.setUint16(3, global, le);
  head[5] = fields.length;
  fields.forEach((f, i) => {
    head[6 + i * 3] = f.num;
    head[7 + i * 3] = f.size ?? BASE[f.base].size;
    head[8 + i * 3] = BASE[f.base].code;
  });
  if (!opts.dev) return head;
  // developer fields: (field number, size, developer data index)
  const dev = new Uint8Array(1 + opts.dev.length * 3);
  dev[0] = opts.dev.length;
  opts.dev.forEach((size, i) => {
    dev[1 + i * 3] = i;
    dev[2 + i * 3] = size;
    dev[3 + i * 3] = 0;
  });
  return cat([head, dev]);
}

/** A data message for `local`, values in the definition's order. `header` overrides the
 *  normal header byte (a compressed-timestamp header, say). */
function data(local: number, fields: Field[], values: (number | string)[], opts: { bigEndian?: boolean; header?: number; devBytes?: number } = {}): Uint8Array {
  const le = !opts.bigEndian;
  const size = fields.reduce((s, f) => s + (f.size ?? BASE[f.base].size), 0) + (opts.devBytes ?? 0);
  const out = new Uint8Array(1 + size);
  const dv = new DataView(out.buffer);
  out[0] = opts.header ?? local;
  let o = 1;
  fields.forEach((f, i) => {
    const v = values[i]!;
    const width = f.size ?? BASE[f.base].size;
    switch (f.base) {
      case "enum":
      case "uint8":
        out[o] = v as number;
        break;
      case "uint16":
        dv.setUint16(o, v as number, le);
        break;
      case "sint32":
        dv.setInt32(o, v as number, le);
        break;
      case "uint32":
        dv.setUint32(o, v as number, le);
        break;
      case "float32":
        dv.setFloat32(o, v as number, le);
        break;
      case "string": {
        const enc = new TextEncoder().encode(String(v)).subarray(0, width - 1);
        out.set(enc, o); // the rest of the field stays 0: the terminator
        break;
      }
    }
    o += width;
  });
  return out;
}

/** Header + records + CRC. `dataSize` overrides the header's own count. */
function fitFile(records: Uint8Array[], opts: { headerSize?: 12 | 14; dataSize?: number; noCrc?: boolean } = {}): ArrayBuffer {
  const body = cat(records);
  const headerSize = opts.headerSize ?? 14;
  const head = new Uint8Array(headerSize);
  const dv = new DataView(head.buffer);
  head[0] = headerSize;
  head[1] = 0x20; // protocol version
  dv.setUint16(2, 2100, true); // profile version
  dv.setUint32(4, opts.dataSize ?? body.length, true);
  head.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
  const crc = new Uint8Array(opts.noCrc ? 0 : 2); // never checked, so zero is as good as any
  return cat([head, body, crc]).buffer;
}

/** the record definition a watch writes: timestamp, position, the two altitudes */
const RECORD_FIELDS: Field[] = [
  { num: 253, base: "uint32" },
  { num: 0, base: "sint32" },
  { num: 1, base: "sint32" },
  { num: 2, base: "uint16" },
];
const record = (lat: number, lon: number, ele: number, t = 1000, opts = {}) =>
  data(0, RECORD_FIELDS, [t, semicircles(lat), semicircles(lon), alt16(ele)], opts);
const hoodFile = () => fitFile([definition(0, 20, RECORD_FIELDS), ...HOOD.map(([la, lo, e], i) => record(la, lo, e, 1000 + i))]);

const closeTo = (points: { lat: number; lon: number; ele?: number }[], expected: [number, number, number][]) => {
  expect(points).toHaveLength(expected.length);
  points.forEach((p, i) => {
    // a semicircle is 8.4e-8 of a degree, well under a centimetre; the rounding is the
    // format's, not ours
    expect(p.lat).toBeCloseTo(expected[i]![0], 6);
    expect(p.lon).toBeCloseTo(expected[i]![1], 6);
    expect(p.ele).toBe(expected[i]![2]);
  });
};

describe("isFit", () => {
  it("knows a FIT header by its signature, wherever the name went", () => {
    expect(isFit(new Uint8Array(hoodFile()).subarray(0, 12))).toBe(true);
    expect(isFit(new TextEncoder().encode("<gpx/>"))).toBe(false);
    expect(isFit(new Uint8Array(0))).toBe(false);
    // a 12-byte header (no header CRC) is the older, still-common form
    expect(isFit(new Uint8Array(fitFile([], { headerSize: 12 })).subarray(0, 12))).toBe(true);
  });
});

describe("fitRoute — the track", () => {
  it("lands on the same points as the GPX of the same walk", () => {
    const { points, pins } = fitRoute(hoodFile());
    closeTo(points, HOOD);
    expect(pins).toEqual([]);
    const fromGpx = gpxPoints(xml(GPX));
    points.forEach((p, i) => {
      expect(p.lat).toBeCloseTo(fromGpx[i]!.lat, 6);
      expect(p.lon).toBeCloseTo(fromGpx[i]!.lon, 6);
      expect(p.ele).toBe(fromGpx[i]!.ele);
    });
  });

  it("feeds the same stats as the other formats, so the estimates don't care who wrote it", () => {
    const fromFit = gpxStats(fitRoute(hoodFile()).points)!;
    const fromGpx = gpxStats(gpxPoints(xml(GPX)))!;
    expect(fromFit.distanceM).toBeCloseTo(fromGpx.distanceM, 1);
    expect(fromFit.ascentM).toBe(fromGpx.ascentM);
    expect(fromFit.profile).toEqual(fromGpx.profile);
  });

  it("skips a sample with no fix, and a message that isn't a record", () => {
    const hr: Field[] = [{ num: 253, base: "uint32" }, { num: 3, base: "uint8" }]; // a heart-rate-only record
    const fileId: Field[] = [{ num: 0, base: "enum" }, { num: 1, base: "uint16" }]; // global 0
    const file = fitFile([
      definition(1, 0, fileId),
      data(1, fileId, [4, 1]),
      definition(0, 20, RECORD_FIELDS),
      data(0, RECORD_FIELDS, [999, INVALID_SINT32, INVALID_SINT32, alt16(1790)]), // no fix yet
      ...HOOD.map(([la, lo, e], i) => record(la, lo, e, 1000 + i)),
      definition(2, 20, hr),
      data(2, hr, [1003, 140]),
    ]);
    closeTo(fitRoute(file).points, HOOD);
  });

  it("prefers enhanced_altitude, falls back to altitude, and carries none when neither is there", () => {
    const both: Field[] = [...RECORD_FIELDS, { num: 78, base: "uint32" }];
    const withBoth = fitFile([definition(0, 20, both), data(0, both, [1, semicircles(45.33), semicircles(-121.71), alt16(1800), alt16(1812)])]);
    expect(fitRoute(withBoth).points[0]!.ele).toBe(1812);

    const bare: Field[] = [{ num: 0, base: "sint32" }, { num: 1, base: "sint32" }];
    const flat = fitFile([definition(0, 20, bare), data(0, bare, [semicircles(45.33), semicircles(-121.71)])]);
    expect(fitRoute(flat).points[0]).toEqual({ lat: expect.closeTo(45.33, 6), lon: expect.closeTo(-121.71, 6) });
    expect("ele" in fitRoute(flat).points[0]!).toBe(false);

    // an altitude the device declined to give (the uint16 invalid value) is no altitude
    const noAlt = fitFile([definition(0, 20, RECORD_FIELDS), data(0, RECORD_FIELDS, [1, semicircles(45.33), semicircles(-121.71), 0xffff])]);
    expect("ele" in fitRoute(noAlt).points[0]!).toBe(false);
  });

  it("falls back to altitude when enhanced_altitude is there but invalid", () => {
    const both: Field[] = [...RECORD_FIELDS, { num: 78, base: "uint32" }];
    const file = fitFile([definition(0, 20, both), data(0, both, [1, semicircles(45.33), semicircles(-121.71), alt16(1800), 0xffffffff])]);
    expect(fitRoute(file).points[0]!.ele).toBe(1800);
  });

  it("reads a 12-byte header, the older form with no header CRC", () => {
    const file = fitFile([definition(0, 20, RECORD_FIELDS), ...HOOD.map(([la, lo, e], i) => record(la, lo, e, 1000 + i))], { headerSize: 12 });
    closeTo(fitRoute(file).points, HOOD);
  });

  it("carries a known altitude across the samples that lack one", () => {
    // the first seconds of a recording: a fix before the barometer has settled
    const file = fitFile([
      definition(0, 20, RECORD_FIELDS),
      data(0, RECORD_FIELDS, [1, semicircles(45.33), semicircles(-121.71), 0xffff]),
      data(0, RECORD_FIELDS, [2, semicircles(45.34), semicircles(-121.7), alt16(1850)]),
      data(0, RECORD_FIELDS, [3, semicircles(45.345), semicircles(-121.695), 0xffff]),
      data(0, RECORD_FIELDS, [4, semicircles(45.35), semicircles(-121.69), alt16(1900)]),
    ]);
    expect(fitRoute(file).points.map((p) => p.ele)).toEqual([1850, 1850, 1850, 1900]);
    // …and the whole profile survives, which is the point: gpxStats wants every point to have one
    expect(gpxStats(fitRoute(file).points)!.ascentM).toBeGreaterThan(0);
  });

  it("reads a big-endian file to the same points", () => {
    const be = { bigEndian: true };
    const file = fitFile([definition(0, 20, RECORD_FIELDS, be), ...HOOD.map(([la, lo, e], i) => record(la, lo, e, 1000 + i, be))]);
    closeTo(fitRoute(file).points, HOOD);
  });

  it("reads data messages under a compressed timestamp header", () => {
    // high bit set, local type in bits 5–6, a 5-bit time offset in the low bits
    const file = fitFile([
      definition(2, 20, RECORD_FIELDS),
      ...HOOD.map(([la, lo, e], i) => record(la, lo, e, 1000, { header: 0x80 | (2 << 5) | (i + 3) })),
    ]);
    closeTo(fitRoute(file).points, HOOD);
  });

  it("steps over developer fields it never reads", () => {
    // a definition carrying two developer fields (4 and 2 bytes) widens every data message
    const file = fitFile([
      definition(0, 20, RECORD_FIELDS, { dev: [4, 2] }),
      ...HOOD.map(([la, lo, e], i) => record(la, lo, e, 1000 + i, { devBytes: 6 })),
    ]);
    closeTo(fitRoute(file).points, HOOD);
  });

  it("follows a local type that is redefined mid-file", () => {
    const shorter: Field[] = [{ num: 0, base: "sint32" }, { num: 1, base: "sint32" }, { num: 2, base: "uint16" }];
    const file = fitFile([
      definition(0, 20, RECORD_FIELDS),
      record(45.33, -121.71, 1800),
      definition(0, 20, shorter),
      data(0, shorter, [semicircles(45.34), semicircles(-121.7), alt16(1850)]),
      data(0, shorter, [semicircles(45.35), semicircles(-121.69), alt16(1900)]),
    ]);
    closeTo(fitRoute(file).points, HOOD);
  });

  it("reads a field wider than its type as an array and takes the first value", () => {
    const arr: Field[] = [{ num: 0, base: "sint32", size: 8 }, { num: 1, base: "sint32", size: 8 }];
    const msg = new Uint8Array(1 + 16);
    const dv = new DataView(msg.buffer);
    dv.setInt32(1, semicircles(45.33), true);
    dv.setInt32(9, semicircles(-121.71), true);
    const { points } = fitRoute(fitFile([definition(0, 20, arr), msg]));
    expect(points[0]!.lat).toBeCloseTo(45.33, 6);
    expect(points[0]!.lon).toBeCloseTo(-121.71, 6);
  });

  it("reads a chained file, one after another, and each file defines its own types", () => {
    const one = new Uint8Array(fitFile([definition(0, 20, RECORD_FIELDS), record(45.33, -121.71, 1800)]));
    const two = new Uint8Array(fitFile([definition(0, 20, RECORD_FIELDS), record(45.34, -121.7, 1850), record(45.35, -121.69, 1900)]));
    closeTo(fitRoute(cat([one, two]).buffer).points, HOOD);
    // a second file that leans on the first's definition gets nothing: definitions
    // belong to the file that wrote them
    const leaning = new Uint8Array(fitFile([record(45.34, -121.7, 1850)]));
    closeTo(fitRoute(cat([one, leaning]).buffer).points, HOOD.slice(0, 1));
  });

  it("reads the file a zip member hands over, a view into a bigger buffer", () => {
    const whole = new Uint8Array(hoodFile());
    const padded = cat([new Uint8Array(7), whole, new Uint8Array(3)]);
    closeTo(fitRoute(padded.subarray(7, 7 + whole.length)).points, HOOD);
  });
});

describe("fitRoute — what a device leaves behind", () => {
  it("reads to the very end of a file whose header says 0 data bytes, CRC or no CRC", () => {
    // a watch writes the count last; unplug it first and the header still says 0, and
    // there is no CRC either, so stopping two bytes short would cut the last record
    const records = [definition(0, 20, RECORD_FIELDS), ...HOOD.map(([la, lo, e]) => record(la, lo, e))];
    closeTo(fitRoute(fitFile(records, { dataSize: 0 })).points, HOOD);
    closeTo(fitRoute(fitFile(records, { dataSize: 0, noCrc: true })).points, HOOD);
  });

  it("keeps what it read before a truncation inside a definition, or inside a compressed-header message", () => {
    const whole = new Uint8Array(fitFile([definition(0, 20, RECORD_FIELDS), record(45.33, -121.71, 1800), definition(1, 20, RECORD_FIELDS)]));
    // cut inside the second definition's field list
    const inDefinition = whole.subarray(0, whole.length - 2 - 5).slice();
    closeTo(fitRoute(inDefinition.buffer).points, HOOD.slice(0, 1));

    const compressed = new Uint8Array(fitFile([
      definition(0, 20, RECORD_FIELDS),
      record(45.33, -121.71, 1800),
      record(45.34, -121.7, 1850, 1000, { header: 0x80 | 0x05 }),
    ]));
    const inMessage = compressed.subarray(0, compressed.length - 2 - 3).slice();
    closeTo(fitRoute(inMessage.buffer).points, HOOD.slice(0, 1));
    // a compressed header naming a type nothing defined ends the read the same way
    const undefinedType = fitFile([definition(0, 20, RECORD_FIELDS), record(45.33, -121.71, 1800), record(45.34, -121.7, 1850, 1000, { header: 0x80 | (3 << 5) })]);
    closeTo(fitRoute(undefinedType).points, HOOD.slice(0, 1));
  });

  it("keeps what it read before a truncation, rather than nothing", () => {
    const whole = new Uint8Array(hoodFile());
    // cut through the third record
    const cut = whole.subarray(0, whole.length - 2 - 6).slice();
    const { points } = fitRoute(cut.buffer);
    closeTo(points, HOOD.slice(0, 2));
  });

  it("keeps what it read before a data message with no definition", () => {
    const file = fitFile([definition(0, 20, RECORD_FIELDS), record(45.33, -121.71, 1800), data(5, RECORD_FIELDS, [1, 2, 3, 4])]);
    closeTo(fitRoute(file).points, HOOD.slice(0, 1));
  });

  it("drops a position that can't be one", () => {
    const off: Field[] = [{ num: 0, base: "sint32" }, { num: 1, base: "sint32" }];
    // A longitude can't overflow: 2^31 semicircles IS 180°, and the largest count a
    // sint32 holds, one short of it, is the invalid value. A latitude can, since the
    // same range reaches 180° where 90° is the pole, and that is the corrupt file this
    // guards against.
    const file = fitFile([definition(0, 20, off), data(0, off, [semicircles(135), semicircles(-121.71)])]);
    expect(fitRoute(file).points).toEqual([]);
  });

  it("gives nothing for junk and for an empty file, and never throws", () => {
    expect(fitRoute(new TextEncoder().encode("<gpx/>").buffer)).toEqual({ points: [], pins: [] });
    expect(fitRoute(new ArrayBuffer(0))).toEqual({ points: [], pins: [] });
    expect(fitRoute(fitFile([]))).toEqual({ points: [], pins: [] });
    // a header and nothing after it, not even the CRC
    expect(fitRoute(fitFile([], { noCrc: true }))).toEqual({ points: [], pins: [] });
    // a header claiming more data than there is
    expect(fitRoute(fitFile([definition(0, 20, RECORD_FIELDS)], { dataSize: 5000 })).points).toEqual([]);
    // a header size below the format's smallest
    const tiny = new Uint8Array(hoodFile()).slice();
    tiny[0] = 8;
    expect(fitRoute(tiny.buffer)).toEqual({ points: [], pins: [] });
  });

  it("does no more work per byte on a file built to be expensive", () => {
    // 255 zero-width fields on the record definition: every one-byte data message used to
    // walk the whole field list. Ten thousand of them should cost what ten thousand bytes cost.
    const many: Field[] = Array.from({ length: 255 }, (_, i) => ({ num: 100 + (i % 100), base: "uint8", size: 0 }));
    const msgs = Array.from({ length: 10_000 }, () => new Uint8Array([0]));
    const started = performance.now();
    expect(fitRoute(fitFile([definition(0, 20, many), ...msgs])).points).toEqual([]);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("fitRoute — a course's placed points", () => {
  const COURSE_POINT_FIELDS: Field[] = [
    { num: 1, base: "uint32" }, // timestamp: field 1 on this message, not 253

    { num: 2, base: "sint32" },
    { num: 3, base: "sint32" },
    { num: 5, base: "enum" },
    { num: 6, base: "string", size: 16 },
  ];
  const point = (lat: number, lon: number, type: number, name: string) =>
    data(3, COURSE_POINT_FIELDS, [1, semicircles(lat), semicircles(lon), type, name]);

  it("offers the places as pins, in the words pinKind reads", () => {
    const file = fitFile([
      definition(0, 20, RECORD_FIELDS),
      ...HOOD.map(([la, lo, e]) => record(la, lo, e)),
      definition(3, 32, COURSE_POINT_FIELDS),
      point(45.331, -121.709, 3, "Zigzag spring"),
      point(45.341, -121.699, 27, "Paradise Park"),
      point(45.351, -121.689, 1, "Summit"),
    ]);
    const { points, pins } = fitRoute(file);
    expect(points).toHaveLength(3); // the course points never join the track
    expect(pins.map((p) => [p.name, p.sym])).toEqual([
      ["Zigzag spring", "water"],
      ["Paradise Park", "campsite"],
      ["Summit", "summit"],
    ]);
    expect(pins.map(pinKind)).toEqual(["water", "camp", "landmark"]);
    expect(pins[0]!.lat).toBeCloseTo(45.331, 6);
  });

  it("takes a point with no type, or an invalid one, as a generic place", () => {
    const untyped: Field[] = [{ num: 2, base: "sint32" }, { num: 3, base: "sint32" }, { num: 6, base: "string", size: 8 }];
    const file = fitFile([
      definition(3, 32, untyped),
      data(3, untyped, [semicircles(45.33), semicircles(-121.71), "Cairn"]),
      definition(4, 32, COURSE_POINT_FIELDS),
      data(4, COURSE_POINT_FIELDS, [1, semicircles(45.34), semicircles(-121.7), 0xff, "Unknown"]),
    ]);
    expect(fitRoute(file).pins.map((p) => [p.name, p.sym])).toEqual([["Cairn", "generic"], ["Unknown", "generic"]]);
  });

  it("ignores a name field that isn't a string, and a name that is only spaces", () => {
    const odd: Field[] = [{ num: 2, base: "sint32" }, { num: 3, base: "sint32" }, { num: 5, base: "uint8" }, { num: 6, base: "uint16" }];
    const file = fitFile([definition(3, 32, odd), data(3, odd, [semicircles(45.33), semicircles(-121.71), 3, 7])]);
    expect(fitRoute(file).pins).toEqual([{ lat: expect.closeTo(45.33, 6), lon: expect.closeTo(-121.71, 6), name: undefined, sym: "water" }]);
    const blank = fitFile([definition(3, 32, COURSE_POINT_FIELDS), point(45.33, -121.71, 3, "   ")]);
    expect(fitRoute(blank).pins[0]!.name).toBeUndefined();
  });

  it("stops offering pins past the cap, in file order", () => {
    const pts = Array.from({ length: MAX_FIT_PINS + 20 }, (_, i) => point(45 + i * 0.0001, -121, 3, `Stop ${i}`));
    const { pins } = fitRoute(fitFile([definition(3, 32, COURSE_POINT_FIELDS), ...pts]));
    expect(pins).toHaveLength(MAX_FIT_PINS);
    expect(pins[0]!.name).toBe("Stop 0");
  });

  it("leaves the turn-by-turn cues out", () => {
    const file = fitFile([
      definition(3, 32, COURSE_POINT_FIELDS),
      point(45.33, -121.71, 6, "Turn left onto Timberline Trail"),
      point(45.34, -121.7, 34, "Mile 3"),
      point(45.35, -121.69, 3, ""),
    ]);
    const { pins } = fitRoute(file);
    // the unnamed water stop still counts: its position is the part that was hard to come by
    expect(pins).toEqual([{ lat: expect.closeTo(45.35, 6), lon: expect.closeTo(-121.69, 6), name: undefined, sym: "water" }]);
  });
});

describe("a FIT inside a zip, which is how Garmin Connect exports the original", () => {
  /** a stored zip with one member, the KMZ test's builder over bytes rather than text */
  function zip(name: string, body: Uint8Array): ArrayBuffer {
    const nameB = new TextEncoder().encode(name);
    const local = 30 + nameB.length;
    const central = 46 + nameB.length;
    const buf = new Uint8Array(local + body.length + central + 22);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint32(18, body.length, true);
    dv.setUint32(22, body.length, true);
    dv.setUint16(26, nameB.length, true);
    buf.set(nameB, 30);
    buf.set(body, local);
    const cdAt = local + body.length;
    dv.setUint32(cdAt, 0x02014b50, true);
    dv.setUint32(cdAt + 20, body.length, true);
    dv.setUint16(cdAt + 28, nameB.length, true);
    dv.setUint32(cdAt + 42, 0, true);
    buf.set(nameB, cdAt + 46);
    const eocd = cdAt + central;
    dv.setUint32(eocd, 0x06054b50, true);
    dv.setUint16(eocd + 8, 1, true);
    dv.setUint16(eocd + 10, 1, true);
    dv.setUint32(eocd + 16, cdAt, true);
    return buf.buffer;
  }

  it("is found by name, sniffed by signature, and read from its own bytes", async () => {
    const member = await zipMember(zip("12345678_ACTIVITY.fit", new Uint8Array(hoodFile())), (n) => /\.(kml|fit)$/i.test(n));
    expect(member?.name).toBe("12345678_ACTIVITY.fit");
    expect(isFit(member!.bytes)).toBe(true);
    closeTo(fitRoute(member!.bytes).points, HOOD);
  });

  it("is passed over when the zip holds no route file", async () => {
    expect(await zipMember(zip("readme.txt", new TextEncoder().encode("hi")), (n) => /\.(kml|fit)$/i.test(n))).toBeNull();
  });
});
