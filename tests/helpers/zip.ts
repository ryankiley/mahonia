// A zip written byte by byte, for the suites that read one: a KMZ (gpx.test.ts) and the
// FIT a Garmin Connect export wraps (fit.test.ts).

import { deflateRawSync } from "node:zlib";

/** A real zip, built here rather than mocked, so the central-directory walk is
 *  genuinely exercised. `method` 0 is stored; 8 would be deflate. */
export type ZipInput = { name: string; body: string | Uint8Array; deflate?: boolean };

export function zipEntries(entries: readonly ZipInput[]): ArrayBuffer {
  const enc = new TextEncoder();
  const prepared = entries.map(({ name, body, deflate = false }) => {
    const raw = typeof body === "string" ? enc.encode(body) : body;
    return {
      nameB: enc.encode(name),
      raw,
      data: deflate ? new Uint8Array(deflateRawSync(raw)) : raw,
      method: deflate ? 8 : 0,
      localAt: 0,
    };
  });
  const localSize = prepared.reduce((size, entry) => size + 30 + entry.nameB.length + entry.data.length, 0);
  const centralSize = prepared.reduce((size, entry) => size + 46 + entry.nameB.length, 0);
  const buf = new Uint8Array(localSize + centralSize + 22);
  const dv = new DataView(buf.buffer);
  let o = 0;

  for (const entry of prepared) {
    entry.localAt = o;
    dv.setUint32(o, 0x04034b50, true);            // local header
    dv.setUint16(o + 8, entry.method, true);
    dv.setUint32(o + 18, entry.data.length, true); // compressed size
    dv.setUint32(o + 22, entry.raw.length, true);  // uncompressed size
    dv.setUint16(o + 26, entry.nameB.length, true);
    buf.set(entry.nameB, o + 30);
    buf.set(entry.data, o + 30 + entry.nameB.length);
    o += 30 + entry.nameB.length + entry.data.length;
  }

  const cdAt = o;
  for (const entry of prepared) {
    dv.setUint32(o, 0x02014b50, true);            // central directory
    dv.setUint16(o + 10, entry.method, true);
    dv.setUint32(o + 20, entry.data.length, true);
    dv.setUint32(o + 24, entry.raw.length, true);
    dv.setUint16(o + 28, entry.nameB.length, true);
    dv.setUint32(o + 42, entry.localAt, true);    // local header offset
    buf.set(entry.nameB, o + 46);
    o += 46 + entry.nameB.length;
  }

  dv.setUint32(o, 0x06054b50, true);            // end of central directory
  dv.setUint16(o + 8, prepared.length, true);    // entries on this disk
  dv.setUint16(o + 10, prepared.length, true);   // entries total
  dv.setUint32(o + 12, centralSize, true);
  dv.setUint32(o + 16, cdAt, true);              // where the directory starts
  return buf.buffer;
}
