import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import type { SatoriOptions } from "satori";
import { DRAWABLE_RANGES, ogCardAlt, ogCardModel, ogCardTitle } from "../shared/ogCard";
import { ogCardSvg, renderOgCard, renderOgSiteCard } from "../server/utils/ogCard";
import type { Totals, Unit } from "../shared/types";
import { totals } from "./helpers/totals";

// a minimal card source: the model reads title/displayUnit and, only when no
// totals are handed in, rolls up the (empty) items
const src = (title: string, displayUnit: Unit = "g") => ({
  title,
  displayUnit,
  folders: [],
  items: [],
});
const model = (title: string, t: Totals, unit: Unit = "g") => ogCardModel(src(title, unit), t);

// the trail-weight shape most lists have: total 8.43 kg = base + worn + consumable
const weighed = totals({
  totalMg: 8_432_000,
  baseMg: 6_200_000,
  wornMg: 1_432_000,
  consumableMg: 800_000,
  carriedMg: 7_000_000,
  itemCount: 24,
  hasWeights: true,
});

describe("ogCardModel — what the social card says", () => {
  it("headlines the pack weight, magnitude-promoted, with the unit apart", () => {
    expect(model("Wonderland Loop", weighed).big).toEqual({ value: "8.43", unit: "kg" });
  });

  it("rolls up totals itself when none are handed in", () => {
    const m = ogCardModel({
      title: "Two things",
      displayUnit: "g",
      folders: [],
      items: [
        { id: "a", name: "a", folderId: null, unitWeightMg: 700_000, qty: 1, classification: null, sortOrder: 0 },
        { id: "b", name: "b", folderId: null, unitWeightMg: 200_000, qty: 1, classification: "worn", sortOrder: 1 },
      ],
    });
    expect(m.big).toEqual({ value: "900", unit: "g" });
    expect(m.chips.map((c) => c.label)).toEqual(["Base", "Worn"]);
  });

  it("keeps a sub-kilo total in grams", () => {
    const m = model("Day pack", totals({ totalMg: 900_000, baseMg: 900_000, wornMg: 1, hasWeights: true }));
    expect(m.big).toEqual({ value: "900", unit: "g" });
  });

  it("reads in the owner's measurement system, not the metric default", () => {
    // 20 lb exactly; an oz list promotes to pounds like the app's imperial surfaces
    const m = model("JMT kit", totals({ totalMg: 9_071_847, baseMg: 9_071_847, wornMg: 1, hasWeights: true }), "oz");
    expect(m.big.unit).toBe("lb");
  });

  it("mirrors TotalsBar's chips — same rows, same judgment calls", () => {
    expect(model("Wonderland Loop", weighed).chips).toEqual([
      { label: "Base", value: "6.2 kg" },
      { label: "Worn", value: "1.43 kg" },
      { label: "Consumable", value: "800 g" },
    ]);
    // a lone Base chip restates the headline — dropped here exactly as in the bar
    const allBase = model(
      "Simple kit",
      totals({ totalMg: 5_000_000, baseMg: 5_000_000, hasWeights: true, itemCount: 3 }),
    );
    expect(allBase.chips).toEqual([]);
  });

  it("falls back to the item count when the list carries no weights", () => {
    const m = model("Chores", totals({ itemCount: 14 }));
    expect(m.big).toEqual({ value: "14", unit: "items" });
    expect(m.chips).toEqual([]);
    expect(model("One thing", totals({ itemCount: 1 })).big.unit).toBe("item");
  });
});

describe("ogCardTitle — only what the subset fonts can draw", () => {
  it("passes ordinary titles through, whitespace collapsed", () => {
    expect(ogCardTitle("  PCT   2026  ")).toBe("PCT 2026");
    expect(ogCardTitle("Señor Pörter's Kit — v2")).toBe("Señor Pörter’s Kit — v2");
  });

  it("strips glyphs outside the subset (emoji, CJK) without leaving gaps", () => {
    expect(ogCardTitle("Sierra ⛰️ Kit")).toBe("Sierra Kit");
    expect(ogCardTitle("裏山 overnighter")).toBe("overnighter");
  });

  it("strips format characters the fonts have no glyph for", () => {
    // soft hyphen + zero-width joiner sit inside the Latin/punctuation blocks
    // but outside DRAWABLE_RANGES — kept, they'd render as holes
    expect(ogCardTitle(`long${"\u00AD"}name a${"\u200D"}b`)).toBe("longname ab");
  });

  it("falls back to the plain noun rather than a blank card", () => {
    expect(ogCardTitle("🏔️⛺🥾")).toBe("A packing list");
    expect(ogCardTitle("   ")).toBe("A packing list");
  });
});

describe("ogCardAlt — the image described as a sentence", () => {
  it("carries the title, the big figure and the breakdown", () => {
    const alt = ogCardAlt(model("Wonderland Loop", weighed));
    expect(alt).toBe(
      "Wonderland Loop — 8.43 kg. Base 6.2 kg · Worn 1.43 kg · Consumable 800 g. On Mahonia.",
    );
  });

  it("stays a sentence when there is no breakdown", () => {
    const alt = ogCardAlt(model("Chores", totals({ itemCount: 14 })));
    expect(alt).toBe("Chores — 14 items. On Mahonia.");
  });
});

// The drawing pipeline, with the real subset fonts the server ships — satori
// lays out to SVG (deterministic string), resvg rasterizes to PNG bytes. Read
// once at module scope; every test shares the same four buffers.
const FACES = [
  ["inter-regular.ttf", "Inter", 400],
  ["inter-semibold.ttf", "Inter", 600],
  ["interdisplay-regular.ttf", "InterDisplay", 400],
  ["interdisplay-bold.ttf", "InterDisplay", 700],
] as const;
const fontsLoaded: Promise<SatoriOptions["fonts"]> = Promise.all(
  FACES.map(async ([file, name, weight]) => ({
    name,
    weight,
    style: "normal" as const,
    data: await readFile(new URL(`../server/assets/fonts/${file}`, import.meta.url)),
  })),
);

describe("the card renders", () => {
  it("lays out to a 1200×630 SVG with the M mark, long ellipsized titles included", async () => {
    const fonts = await fontsLoaded;
    const svg = await ogCardSvg(model("Wonderland Loop", weighed), fonts);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
    // the favicon's M in the top-right corner rides in as an embedded <image>
    expect(svg).toContain("<image");
    // a name long enough to clamp exercises the wrap + ellipsis path
    const long = await ogCardSvg(
      model(
        "The Complete And Utterly Exhaustive Everything-I-Own Shoulder-Season Wonderland Trail Packing List, Revised Again",
        weighed,
      ),
      fonts,
    );
    expect(long.startsWith("<svg")).toBe(true);
  });

  it("rasterizes to PNG bytes", async () => {
    const png = await renderOgCard(model("Wonderland Loop", weighed), await fontsLoaded);
    // the PNG signature — proof it's a real raster, not an SVG in a trenchcoat
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.length).toBeGreaterThan(5_000);
  });

  it("seats the unit on the big figure's baseline, measured off the pixels", async () => {
    // satori's `alignItems: baseline` degrades to BOX-BOTTOM alignment for
    // element children, which parked the unit ~16px below the number's baseline
    // until server/utils/ogCard.ts compensated from the font's own metrics
    // (UNIT_BASELINE_LIFT). This renders a card and measures: "14" and "items"
    // both end in flat-bottomed glyphs, so their lowest dark rows ARE their
    // baselines, and they must agree. The card has no chips (weightless) and the
    // measurement stays in the lower half, so nothing else can leak into a band.
    const svg = await ogCardSvg(model("Chores", totals({ itemCount: 14 })), await fontsLoaded);
    const img = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
    const { width, height } = img;
    const px = img.pixels; // RGBA rows
    const dark = (x: number, y: number) => px[(y * width + x) * 4]! < 128;
    const bottom = (x0: number, x1: number) => {
      for (let y = height - 1; y > Math.floor(height / 2); y--)
        for (let x = x0; x < x1; x++) if (dark(x, y)) return y;
      return -1;
    };
    const numberBottom = bottom(76, 260); // "14" at 170px
    const unitBottom = bottom(290, 520); // "items" at 54px, right of the margin
    expect(numberBottom).toBeGreaterThan(0);
    expect(unitBottom).toBeGreaterThan(0);
    expect(Math.abs(numberBottom - unitBottom)).toBeLessThanOrEqual(1);
  });
});

// ---- the fonts themselves: the two contracts the card rests on, asserted
// against the shipped bytes rather than trusted to comments.

/** Table-directory walk: tag → offset. */
function tableOffsets(view: DataView): Map<string, number> {
  const out = new Map<string, number>();
  const numTables = view.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(
      view.getUint8(rec),
      view.getUint8(rec + 1),
      view.getUint8(rec + 2),
      view.getUint8(rec + 3),
    );
    out.set(tag, view.getUint32(rec + 8));
  }
  return out;
}

/** A format-4 cmap lookup (BMP — every DRAWABLE range is below U+FFFF). */
function glyphLookup(view: DataView, cmap: number): (cp: number) => number {
  const numTables = view.getUint16(cmap + 2);
  let sub = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = view.getUint16(rec);
    const encoding = view.getUint16(rec + 2);
    if ((platform === 3 && encoding === 1) || (platform === 0 && sub < 0))
      sub = cmap + view.getUint32(rec + 4);
  }
  expect(sub).toBeGreaterThan(0);
  expect(view.getUint16(sub)).toBe(4); // subtable format
  const segCount = view.getUint16(sub + 6) / 2;
  const endCodes = sub + 14;
  const startCodes = endCodes + segCount * 2 + 2; // +2: reservedPad
  const idDeltas = startCodes + segCount * 2;
  const idRangeOffsets = idDeltas + segCount * 2;
  return (cp) => {
    for (let i = 0; i < segCount; i++) {
      if (cp > view.getUint16(endCodes + i * 2)) continue;
      const start = view.getUint16(startCodes + i * 2);
      if (cp < start) return 0;
      const rangeOffset = view.getUint16(idRangeOffsets + i * 2);
      if (rangeOffset === 0) return (cp + view.getInt16(idDeltas + i * 2)) & 0xffff;
      const glyph = view.getUint16(idRangeOffsets + i * 2 + rangeOffset + (cp - start) * 2);
      return glyph === 0 ? 0 : (glyph + view.getInt16(idDeltas + i * 2)) & 0xffff;
    }
    return 0;
  };
}

describe("the shipped fonts hold the card's two contracts", () => {
  it("cover every DRAWABLE_RANGES codepoint — a narrowing re-subset fails here", async () => {
    for (const font of await fontsLoaded) {
      const data = font.data as Buffer;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const cmap = tableOffsets(view).get("cmap");
      expect(cmap).toBeDefined();
      const glyph = glyphLookup(view, cmap!);
      const holes: string[] = [];
      for (const [lo, hi] of DRAWABLE_RANGES)
        for (let cp = lo; cp <= hi; cp++) if (glyph(cp) === 0) holes.push(cp.toString(16));
      expect(holes, `${font.name} ${font.weight} missing glyphs`).toEqual([]);
    }
  });

  it("carry the metrics UNIT_BASELINE_LIFT derives from", async () => {
    // ascender 1984, descender −494, unitsPerEm 2048 — if a re-subset ever
    // swaps faces or versions with different verticals, the baseline seat
    // silently drifts; this pins the derivation to the actual bytes shipped.
    for (const font of await fontsLoaded) {
      const data = font.data as Buffer;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const tables = tableOffsets(view);
      const hhea = tables.get("hhea");
      const head = tables.get("head");
      expect(hhea).toBeDefined();
      expect(head).toBeDefined();
      expect(view.getInt16(hhea! + 4)).toBe(1984); // ascender
      expect(view.getInt16(hhea! + 6)).toBe(-494); // descender
      expect(view.getUint16(head! + 18)).toBe(2048); // unitsPerEm
    }
  });
});

describe("the committed site card (public/og.png)", () => {
  it("matches the template — `npm run og:site` regenerates it after template or font changes", async () => {
    // The generic card is a committed static file (CDN-served; also the render
    // failure fallback, which must not itself be a render). This re-renders the
    // template and compares bytes, so a template edit that forgets the regen is
    // a red test here instead of a stale card in every unfurl.
    const committed = await readFile(new URL("../public/og.png", import.meta.url));
    const fresh = await renderOgSiteCard(await fontsLoaded);
    expect(fresh.equals(committed)).toBe(true);
  });
});

// The breakdown row is a fixed-size flex row that satori will not scroll or wrap, so a
// heavy list ran it off the card: "Consumable 150.03" was cut mid-number with its unit
// gone. cardVnode now steps the row down to fit. Measured off the PIXELS, because the
// bug was a layout overflow and only the raster can prove it isn't there — and because
// satori draws text as paths, so there is no font-size in the SVG to assert on.
describe("the breakdown row stays inside the card", () => {
  // the chips are the last thing on the card, so every measurement scans its floor
  const BAND = 0.82;
  const ink = (svg: string) => {
    const { width, height, pixels } = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
    const dark = (x: number, y: number) => pixels[(y * width + x) * 4]! < 128;
    const y0 = Math.floor(height * BAND);
    let right = -1, top = -1, bottom = -1;
    for (let y = y0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (dark(x, y)) {
          if (top < 0) top = y;
          bottom = y;
          if (x > right) right = x;
        }
    return { right, capHeight: bottom - top };
  };
  const heavy = totals({
    totalMg: 1_000_153_215_000,
    baseMg: 1_000_003_025_000,
    wornMg: 156_000,
    consumableMg: 150_034_000,
    itemCount: 40,
  });

  it("draws an ordinary breakdown inside the padding, unshrunk", async () => {
    const { right } = ink(await ogCardSvg(model("Wonderland Loop", weighed), await fontsLoaded));
    expect(right).toBeGreaterThan(0);
    expect(right).toBeLessThanOrEqual(1200 - 72);
  });

  it("draws a tonne-scale breakdown inside the padding too", async () => {
    const { right } = ink(await ogCardSvg(model("Heavy", heavy), await fontsLoaded));
    expect(right).toBeGreaterThan(0); // the row drew something
    expect(right).toBeLessThanOrEqual(1200 - 72); // and stopped inside the padding
  });

  it("shrinks only the row that needs it", async () => {
    const fonts = await fontsLoaded;
    const ordinary = ink(await ogCardSvg(model("Wonderland Loop", weighed), fonts));
    const big = ink(await ogCardSvg(model("Heavy", heavy), fonts));
    // proof the fit ran, rather than the first row simply being short
    expect(big.capHeight).toBeLessThan(ordinary.capHeight);
  });
});
