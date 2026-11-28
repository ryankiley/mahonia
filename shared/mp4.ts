// MP4, written by hand: one H.264 video track, and only what /trail-spin's Save video needs.
//
// The browser's encoder (WebCodecs) hands back compressed frames and the decoder setup they
// need, and nothing else: wrapping them in a file is the page's job. A muxing library would be
// the bulk of the download for a few hundred lines of boxes, and the house rule is the same
// one the FIT and zip readers follow.
//
// The layout is the plainest a player accepts: every frame in one chunk, and the index (moov)
// AHEAD of the frames (mdat), so a player or an upload can start before the last byte arrives.
// Everything is known before a byte is written, so putting the index first costs nothing.
//
// Frames arrive in DECODE order. An encoder that uses B-frames shows them in another order, so
// each frame carries its own presentation time and the file says how far it is shown from where
// it is decoded (ctts), with an edit list (elst) starting the picture at the first frame shown.
// An encoder that doesn't reorder gets neither box.

/** One frame's place in the file: its size, and when it's shown. The bytes themselves are
 *  handed over apart (mp4Blob's `frames`), so they can arrive already folded into Blobs. */
export interface Mp4Sample {
  size: number;
  /** a keyframe: a player can start here */
  key: boolean;
  /** when it is shown, in microseconds */
  pts: number;
}

/** The colour the frames are coded in, as ISO/IEC 23091-2 numbers (H.273). */
export interface Mp4Colour {
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange: boolean;
}

export interface Mp4Track {
  width: number;
  height: number;
  /** whole frames a second; every frame lasts one */
  fps: number;
  /** the AVCDecoderConfigurationRecord: the encoder's decoderConfig.description */
  avcC: Uint8Array;
  colour?: Mp4Colour;
}

const MOVIE_TIMESCALE = 1000;
/** ticks a frame lasts, in the track's own timescale (fps × this a second) */
const FRAME_TICKS = 1000;
const UNITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

type Part = Uint8Array | readonly number[];

const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

function concat(parts: readonly Part[]): Uint8Array<ArrayBuffer> {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function box(type: string, ...parts: Part[]): Uint8Array<ArrayBuffer> {
  const body = concat(parts);
  return concat([u32(body.length + 8), ascii(type), body]);
}

/** A box with a version and flags ahead of its fields. */
const full = (type: string, version: number, flags: number, ...parts: Part[]) =>
  box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...parts);

/** Repeats folded into [count, value] pairs, the shape stts and ctts store. */
function runs(values: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const v of values) {
    const last = out.at(-1);
    if (last && last[1] === v) last[0]++;
    else out.push([1, v]);
  }
  return out;
}

/**
 * The whole file, as a Blob: the index, then `frames`, which are the samples' bytes in the
 * same order (as arrays, or Blobs already holding several). Given Blobs, the file references
 * them rather than copying, so it costs about its own size to make.
 */
export function mp4Blob(track: Mp4Track, samples: readonly Mp4Sample[], frames: readonly BlobPart[]): Blob {
  if (!samples.length) throw new Error("no frames");
  const timescale = track.fps * FRAME_TICKS;
  const count = samples.length;
  const mediaDuration = count * FRAME_TICKS;
  const movieDuration = Math.round((mediaDuration / timescale) * MOVIE_TIMESCALE);

  // Shown-minus-decoded, per frame, in ticks. Decoded one after another from 0; shown when
  // the encoder said. Shifted so none is negative (ctts version 0 can't say so), and the
  // edit list skips the shift back out.
  const offsets = samples.map((s, i) => Math.round((s.pts / 1e6) * timescale) - i * FRAME_TICKS);
  const shift = Math.max(0, -Math.min(...offsets));
  const reordered = offsets.some((o) => o !== 0);

  let dataBytes = 0;
  for (const s of samples) dataBytes += s.size;
  if (dataBytes + 8 > 0xffffffff) throw new Error("too long for a 32-bit mdat");

  const ftyp = box("ftyp", ascii("isom"), u32(0x200), ascii("isom"), ascii("iso2"), ascii("avc1"), ascii("mp41"));

  const keys = samples.flatMap((s, i) => (s.key ? [i + 1] : []));
  const reorder = reordered ? runs(offsets.map((o) => o + shift)) : [];
  const colour = track.colour;
  const sampleEntry = box(
    "avc1",
    [0, 0, 0, 0, 0, 0], // reserved
    u16(1), // data_reference_index
    u16(0), // pre_defined
    u16(0), // reserved
    u32(0),
    u32(0),
    u32(0), // pre_defined
    u16(track.width),
    u16(track.height),
    u32(0x00480000), // 72 dpi across
    u32(0x00480000), // and down
    u32(0), // reserved
    u16(1), // frames per sample
    new Uint8Array(32), // compressor name, left empty
    u16(0x0018), // depth: colour, no alpha
    u16(0xffff), // pre_defined: -1
    box("avcC", track.avcC),
    colour
      ? box("colr", ascii("nclx"), u16(colour.primaries), u16(colour.transfer), u16(colour.matrix), [
          colour.fullRange ? 0x80 : 0,
        ])
      : [],
  );

  const moov = (chunkOffset: number) =>
    box(
      "moov",
      full(
        "mvhd",
        0,
        0,
        u32(0), // created
        u32(0), // modified
        u32(MOVIE_TIMESCALE),
        u32(movieDuration),
        u32(0x00010000), // rate 1.0
        u16(0x0100), // volume 1.0
        u16(0),
        u32(0),
        u32(0), // reserved
        UNITY_MATRIX.flatMap(u32),
        new Uint8Array(24), // pre_defined
        u32(2), // next track id
      ),
      box(
        "trak",
        full(
          "tkhd",
          0,
          3, // enabled, in the movie
          u32(0),
          u32(0),
          u32(1), // track id
          u32(0),
          u32(movieDuration),
          u32(0),
          u32(0),
          u16(0), // layer
          u16(0), // alternate group
          u16(0), // volume: a video track has none
          u16(0),
          UNITY_MATRIX.flatMap(u32),
          u32(track.width * 65536),
          u32(track.height * 65536),
        ),
        reordered
          ? box("edts", full("elst", 0, 0, u32(1), u32(movieDuration), u32(shift), u16(1), u16(0)))
          : [],
        box(
          "mdia",
          full("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(mediaDuration), u16(0x55c4), u16(0)),
          full("hdlr", 0, 0, u32(0), ascii("vide"), u32(0), u32(0), u32(0), ascii("VideoHandler"), [0]),
          box(
            "minf",
            full("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0)),
            box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))),
            box(
              "stbl",
              full("stsd", 0, 0, u32(1), sampleEntry),
              full("stts", 0, 0, u32(1), u32(count), u32(FRAME_TICKS)),
              reordered ? full("ctts", 0, 0, u32(reorder.length), reorder.flatMap(([n, v]) => [...u32(n), ...u32(v)])) : [],
              keys.length < count ? full("stss", 0, 0, u32(keys.length), keys.flatMap(u32)) : [],
              full("stsc", 0, 0, u32(1), u32(1), u32(count), u32(1)),
              full("stsz", 0, 0, u32(0), u32(count), samples.flatMap((s) => u32(s.size))),
              full("stco", 0, 0, u32(1), u32(chunkOffset)),
            ),
          ),
        ),
      ),
    );

  // The chunk offset is a fixed-width field, so the index is the same size whatever it says:
  // measure it once, then write it with the offset it now knows.
  const offset = ftyp.length + moov(0).length + 8;
  const head = concat([ftyp, moov(offset), u32(dataBytes + 8), ascii("mdat")]);
  return new Blob([head, ...frames], { type: "video/mp4" });
}

/** WebCodecs' names for a colour space, as the numbers the colr box stores. Unknown → none. */
export function mp4Colour(space: {
  primaries?: string | null;
  transfer?: string | null;
  matrix?: string | null;
  fullRange?: boolean | null;
}): Mp4Colour | undefined {
  const PRIMARIES: Record<string, number> = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 };
  const TRANSFER: Record<string, number> = {
    bt709: 1,
    smpte170m: 6,
    linear: 8,
    "iec61966-2-1": 13,
    pq: 16,
    hlg: 18,
  };
  const MATRIX: Record<string, number> = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, "bt2020-ncl": 9 };
  const primaries = space.primaries ? PRIMARIES[space.primaries] : undefined;
  const transfer = space.transfer ? TRANSFER[space.transfer] : undefined;
  const matrix = space.matrix ? MATRIX[space.matrix] : undefined;
  if (primaries === undefined || transfer === undefined || matrix === undefined) return undefined;
  return { primaries, transfer, matrix, fullRange: !!space.fullRange };
}
