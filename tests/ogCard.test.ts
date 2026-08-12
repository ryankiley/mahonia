import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { SatoriOptions } from "satori";
import { ogCardAlt, ogCardModel, ogCardTitle } from "../shared/ogCard";
import { ogCardSvg, renderOgCard } from "../server/utils/ogCard";
import type { Totals } from "../shared/types";

const totals = (over: Partial<Totals>): Totals => ({
  totalMg: 0,
  baseMg: 0,
  wornMg: 0,
  consumableMg: 0,
  carriedMg: 0,
  itemCount: 0,
  hasWeights: false,
  kcalTotal: 0,
  hasKcal: false,
  ...over,
});

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
    const m = ogCardModel("Wonderland Loop", weighed, "g");
    expect(m.big).toEqual({ value: "8.43", unit: "kg" });
  });

  it("keeps a sub-kilo total in grams", () => {
    const m = ogCardModel("Day pack", totals({ totalMg: 900_000, baseMg: 900_000, wornMg: 1, hasWeights: true }), "g");
    expect(m.big).toEqual({ value: "900", unit: "g" });
  });

  it("reads in the owner's measurement system, not the metric default", () => {
    // 20 lb exactly; an oz list promotes to pounds like the app's imperial surfaces
    const m = ogCardModel("JMT kit", totals({ totalMg: 9_071_847, baseMg: 9_071_847, wornMg: 1, hasWeights: true }), "oz");
    expect(m.big.unit).toBe("lb");
  });

  it("mirrors TotalsBar's chips — same rows, same judgment calls", () => {
    const m = ogCardModel("Wonderland Loop", weighed, "g");
    expect(m.chips).toEqual([
      { label: "Base", value: "6.2 kg" },
      { label: "Worn", value: "1.43 kg" },
      { label: "Consumable", value: "800 g" },
    ]);
    // a lone Base chip restates the headline — dropped here exactly as in the bar
    const allBase = ogCardModel(
      "Simple kit",
      totals({ totalMg: 5_000_000, baseMg: 5_000_000, hasWeights: true, itemCount: 3 }),
      "g",
    );
    expect(allBase.chips).toEqual([]);
  });

  it("falls back to the item count when the list carries no weights", () => {
    const m = ogCardModel("Chores", totals({ itemCount: 14 }), "g");
    expect(m.big).toEqual({ value: "14", unit: "items" });
    expect(m.chips).toEqual([]);
    expect(ogCardModel("One thing", totals({ itemCount: 1 }), "g").big.unit).toBe("item");
  });
});

describe("ogCardTitle — only what the subset fonts can draw", () => {
  it("passes ordinary titles through, whitespace collapsed", () => {
    expect(ogCardTitle("  PCT   2026  ")).toBe("PCT 2026");
    expect(ogCardTitle("Señor Pörter's Kit — v2")).toBe("Señor Pörter's Kit — v2");
  });

  it("strips glyphs outside the subset (emoji, CJK) without leaving gaps", () => {
    expect(ogCardTitle("Sierra ⛰️ Kit")).toBe("Sierra Kit");
    expect(ogCardTitle("裏山 overnighter")).toBe("overnighter");
  });

  it("falls back to the plain noun rather than a blank card", () => {
    expect(ogCardTitle("🏔️⛺🥾")).toBe("A packing list");
    expect(ogCardTitle("   ")).toBe("A packing list");
  });
});

describe("ogCardAlt — the image described as a sentence", () => {
  it("carries the title, the big figure and the breakdown", () => {
    const alt = ogCardAlt(ogCardModel("Wonderland Loop", weighed, "g"));
    expect(alt).toBe(
      "Wonderland Loop — 8.43 kg. Base 6.2 kg · Worn 1.43 kg · Consumable 800 g. On Mahonia.",
    );
  });

  it("stays a sentence when there is no breakdown", () => {
    const alt = ogCardAlt(ogCardModel("Chores", totals({ itemCount: 14 }), "g"));
    expect(alt).toBe("Chores — 14 items. On Mahonia.");
  });
});

// The drawing pipeline, with the real subset fonts the server ships — satori
// lays out to SVG (deterministic string), resvg rasterizes to PNG bytes.
async function loadFonts(): Promise<SatoriOptions["fonts"]> {
  const load = async (file: string, name: string, weight: 400 | 600 | 700) => ({
    name,
    weight,
    style: "normal" as const,
    data: await readFile(new URL(`../server/assets/fonts/${file}`, import.meta.url)),
  });
  return Promise.all([
    load("inter-regular.ttf", "Inter", 400),
    load("inter-semibold.ttf", "Inter", 600),
    load("interdisplay-regular.ttf", "InterDisplay", 400),
    load("interdisplay-bold.ttf", "InterDisplay", 700),
  ]);
}

describe("the card renders", () => {
  it("lays out to a 1200×630 SVG, long ellipsized titles included", async () => {
    const fonts = await loadFonts();
    const svg = await ogCardSvg(ogCardModel("Wonderland Loop", weighed, "g"), fonts);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
    // a name long enough to clamp exercises the wrap + ellipsis path
    const long = await ogCardSvg(
      ogCardModel(
        "The Complete And Utterly Exhaustive Everything-I-Own Shoulder-Season Wonderland Trail Packing List, Revised Again",
        weighed,
        "g",
      ),
      fonts,
    );
    expect(long.startsWith("<svg")).toBe(true);
  });

  it("rasterizes to PNG bytes", async () => {
    const png = await renderOgCard(ogCardModel("Wonderland Loop", weighed, "g"), await loadFonts());
    // the PNG signature — proof it's a real raster, not an SVG in a trenchcoat
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.length).toBeGreaterThan(5_000);
  });
});
