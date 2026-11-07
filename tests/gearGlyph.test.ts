import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GEAR_GLYPHS, gearGlyphFor } from "../shared/gearGlyph";
import { parseCsv } from "../shared/exporters/csv";
import { CATALOG_CSV } from "../scripts/paths";

describe("which icon a gear type wears", () => {
  it.each([
    ["Backpack", "backpack"],
    ["Fanny pack", "backpack"],
    ["Tent", "tent"],
    ["Tarp", "tent"],
    ["Tent stakes", "tent"],
    ["Quilt", "sleep"],
    ["Sleeping bag", "sleep"],
    ["Pillow", "sleep"],
    ["Sleeping pad", "pad"],
    ["Trekking poles", "poles"],
    ["Stuff sack", "bag"],
    ["Dry bag", "bag"],
    ["Rain jacket", "jacket"],
    ["Down jacket", "jacket"],
    ["Fleece", "jacket"],
    ["Base layer top", "shirt"],
    ["Hiking pants", "pants"],
    ["Shorts", "pants"],
    ["Trail runners", "shoe"],
    ["Sandals", "shoe"],
    ["Beanie", "hat"],
    ["Water bottle", "bottle"],
    ["Soft flask", "bottle"],
    ["Water reservoir", "bottle"],
    ["Water filter", "filter"],
    ["Stove", "stove"],
    ["Fuel canister", "stove"],
    ["Cup", "pot"],
    ["Spork", "pot"],
    ["Energy bar", "food"],
    ["Meal", "food"],
    ["Headlamp", "electronics"],
    ["GPS watch", "electronics"],
    ["Power bank", "electronics"],
    ["Earbuds", "electronics"],
    ["Sunscreen", "toiletry"],
    ["Toothbrush", "toiletry"],
    ["Trowel", "toilet"],
    ["First aid kit", "firstAid"],
  ])("%s → %s", (type, glyph) => {
    expect(gearGlyphFor(type)).toBe(glyph);
  });

  // the narrow name sits above the broad one it would otherwise lose to
  it.each([
    ["Neck gaiter", "hat"],
    ["Gaiters", "socks"],
    ["Running vest", "backpack"],
    ["Vest", "jacket"],
    ["Fleece pants", "pants"],
    ["Bottle cap", "bottle"],
    ["Stake bag", "bag"],
    ["Coffee filter", "pot"],
    ["Pill bottle", "firstAid"],
    ["Toiletry bottle", "toiletry"],
    ["Phone case", "electronics"],
    ["Camera case", "electronics"],
    ["Toothbrush case", "toiletry"],
    ["Pack liner", "bag"],
    ["Toiletry bag", "bag"],
    ["Face wipe", "toilet"],
  ])("%s → %s, not the broader rule", (type, glyph) => {
    expect(gearGlyphFor(type)).toBe(glyph);
  });

  it("reads a typed type the same as the catalog's spelling", () => {
    expect(gearGlyphFor("  stuff   SACK ")).toBe("bag");
    expect(gearGlyphFor("hiking boots")).toBe("shoe");
  });

  // the long tail goes without: a one-off icon is a picture to decode
  it("answers null for the long tail rather than giving it a one-off icon", () => {
    for (const type of ["Camp chair", "Card game", "Compass", "Carabiner", "Umbrella", "Ice axe", "Earplugs"]) {
      expect(gearGlyphFor(type)).toBeNull();
    }
    expect(gearGlyphFor("")).toBeNull();
    expect(gearGlyphFor(null)).toBeNull();
    expect(gearGlyphFor(undefined)).toBeNull();
  });

  it("keeps the set small", () => {
    expect(GEAR_GLYPHS.length).toBeLessThanOrEqual(30);
  });

  // A floor, not a target: the catalog is where most gear types come from, and a new
  // research batch that adds a common type with no icon should say so here.
  it("gives an icon to at least 90% of the catalog's rows", () => {
    const [head, ...rows] = parseCsv(readFileSync(CATALOG_CSV, "utf8"));
    const col = head!.indexOf("common_name");
    const typed = rows.filter((r) => r[col]);
    const pictured = typed.filter((r) => gearGlyphFor(r[col]) !== null);
    expect(pictured.length / typed.length).toBeGreaterThanOrEqual(0.9);
  });
});
