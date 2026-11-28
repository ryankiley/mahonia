import { describe, expect, it } from "vitest";
import { mp4Blob, mp4Colour, type Mp4Sample } from "../shared/mp4";

// Walks the boxes of a written file back out: [type, start of body, end] for every box, nested
// ones included, so a test can find any of them by type.
interface Found {
  type: string;
  body: number;
  end: number;
}
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);
function boxes(bytes: Uint8Array, start = 0, end = bytes.length, out: Found[] = []): Found[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = start;
  while (at + 8 <= end) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    out.push({ type, body: at + 8, end: at + size });
    if (CONTAINERS.has(type)) boxes(bytes, at + 8, at + size, out);
    // the sample entry holds boxes after its 78 bytes of fields
    if (type === "stsd") boxes(bytes, at + 16, at + size, out);
    if (type === "avc1") boxes(bytes, at + 8 + 78, at + size, out);
    at += size;
  }
  return out;
}
const read = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const u32At = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
const find = (all: Found[], type: string) => all.find((b) => b.type === type);

const track = { width: 1080, height: 1920, fps: 60, avcC: new Uint8Array([1, 0x64, 0, 0x2a, 0xff, 0xe1]) };
type TestFrame = Mp4Sample & { data: Uint8Array<ArrayBuffer> };
const frame = (i: number, pts = i, key = i % 4 === 0): TestFrame => ({
  data: new Uint8Array(10 + i).fill(i + 1),
  size: 10 + i,
  key,
  pts: Math.round((pts * 1e6) / 60),
});
/** the writer with each frame's bytes handed over beside its entry, as the encoder does */
const write = (t: Parameters<typeof mp4Blob>[0], ss: TestFrame[]) => mp4Blob(t, ss, ss.map((f) => f.data));

describe("mp4Blob", () => {
  it("puts the index ahead of the frames, and points it at the first frame's bytes", async () => {
    const samples = Array.from({ length: 6 }, (_, i) => frame(i));
    const bytes = await read(write(track, samples));
    const all = boxes(bytes);
    expect(all.map((b) => b.type).slice(0, 3)).toEqual(["ftyp", "moov", "mvhd"]);
    const moov = find(all, "moov")!;
    const mdat = find(all, "mdat")!;
    expect(moov.end).toBeLessThanOrEqual(mdat.body - 8);
    const stco = find(all, "stco")!;
    const offset = u32At(bytes, stco.body + 8);
    expect(offset).toBe(mdat.body);
    expect([...bytes.subarray(offset, offset + 10)]).toEqual(Array(10).fill(1));
    // and the frames run on in order to the end of the file
    expect(mdat.end).toBe(bytes.length);
    expect(bytes.at(-1)).toBe(6);
  });

  it("records each frame's size, the frame count, and the length in time", async () => {
    const samples = Array.from({ length: 6 }, (_, i) => frame(i));
    const bytes = await read(write(track, samples));
    const all = boxes(bytes);
    const stsz = find(all, "stsz")!;
    expect(u32At(bytes, stsz.body + 8)).toBe(6);
    expect(Array.from({ length: 6 }, (_, i) => u32At(bytes, stsz.body + 12 + 4 * i))).toEqual([10, 11, 12, 13, 14, 15]);
    const stts = find(all, "stts")!;
    expect(u32At(bytes, stts.body + 8)).toBe(6); // frames
    const mdhd = find(all, "mdhd")!;
    // duration over timescale: six frames at 60 a second is a tenth of a second
    expect(u32At(bytes, mdhd.body + 16) / u32At(bytes, mdhd.body + 12)).toBeCloseTo(0.1, 9);
    const mvhd = find(all, "mvhd")!;
    expect(u32At(bytes, mvhd.body + 16)).toBe(100); // 6 frames at 60 = 0.1 s, in ms
    const tkhd = find(all, "tkhd")!;
    expect(u32At(bytes, tkhd.body + 76) / 65536).toBe(1080);
    expect(u32At(bytes, tkhd.body + 80) / 65536).toBe(1920);
  });

  it("lists the keyframes, and leaves the list out when every frame is one", async () => {
    const stssBytes = await read(write(track, Array.from({ length: 6 }, (_, i) => frame(i))));
    const stss = find(boxes(stssBytes), "stss")!;
    expect(u32At(stssBytes, stss.body + 4)).toBe(2);
    expect([u32At(stssBytes, stss.body + 8), u32At(stssBytes, stss.body + 12)]).toEqual([1, 5]);
    const allKeys = boxes(await read(write(track, Array.from({ length: 6 }, (_, i) => frame(i, i, true)))));
    expect(find(allKeys, "stss")).toBeUndefined();
  });

  it("needs no reordering boxes when frames are shown in the order they're decoded", async () => {
    const all = boxes(await read(write(track, Array.from({ length: 6 }, (_, i) => frame(i)))));
    expect(find(all, "ctts")).toBeUndefined();
    expect(find(all, "elst")).toBeUndefined();
  });

  it("says how far a reordered frame is shown from where it's decoded, none of it negative", async () => {
    // I P B B: decoded 0 3 1 2, shown 0 1 2 3
    const order = [0, 3, 1, 2];
    const bytes = await read(write(track, order.map((pts, i) => frame(i, pts, i === 0))));
    const all = boxes(bytes);
    const ctts = find(all, "ctts")!;
    const entries = u32At(bytes, ctts.body + 4);
    const pairs = Array.from({ length: entries }, (_, k) => [
      u32At(bytes, ctts.body + 8 + 8 * k),
      u32At(bytes, ctts.body + 12 + 8 * k),
    ]);
    // shown − decoded is 0, +2, −1, −1 frames; shifted by one frame (1000 ticks) to 1, 3, 0, 0
    expect(pairs).toEqual([
      [1, 1000],
      [1, 3000],
      [2, 0],
    ]);
    const elst = find(all, "elst")!;
    expect(u32At(bytes, elst.body + 12)).toBe(1000); // the picture starts one frame in
  });

  it("tags the colour when the encoder said what it is", async () => {
    const colour = mp4Colour({ primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false });
    expect(colour).toEqual({ primaries: 1, transfer: 1, matrix: 1, fullRange: false });
    const bytes = await read(write({ ...track, colour }, [frame(0)]));
    const colr = find(boxes(bytes), "colr")!;
    expect(String.fromCharCode(...bytes.subarray(colr.body, colr.body + 4))).toBe("nclx");
    expect(mp4Colour({ primaries: "bt709", transfer: "made-up", matrix: "bt709" })).toBeUndefined();
    expect(find(boxes(await read(write(track, [frame(0)]))), "colr")).toBeUndefined();
  });

  it("writes the same file whether the frames come one array each or folded into Blobs", async () => {
    const samples = Array.from({ length: 7 }, (_, i) => frame(i));
    const flat = await read(write(track, samples));
    const folded = await read(
      mp4Blob(track, samples, [new Blob(samples.slice(0, 3).map((f) => f.data)), new Blob(samples.slice(3).map((f) => f.data))]),
    );
    expect(folded).toEqual(flat);
  });

  it("refuses a file with no frames", () => {
    expect(() => write(track, [])).toThrow();
  });
});
