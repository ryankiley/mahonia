import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GEAR_GLYPHS, gearGlyphFor } from "../shared/gearGlyph";
import { parseCsv } from "../shared/exporters/csv";
import { CATALOG_CSV } from "../scripts/paths";

describe("which picture a gear type wears", () => {
  it.each([
    ["Backpack", "backpack"],
    ["Tent", "tent"],
    ["Quilt", "quilt"],
    ["Sleeping bag", "sleepingBag"],
    ["Sleeping pad", "pad"],
    ["Trekking poles", "poles"],
    ["Stuff sack", "stuffSack"],
    ["Rain jacket", "jacket"],
    ["Wind shirt", "jacket"],
    ["Water bottle", "bottle"],
    ["Water filter", "filter"],
    ["Earbuds", "earbuds"],
    ["Trail runners", "runningShoes"],
    ["Energy bar", "bar"],
  ])("%s → %s", (type, glyph) => {
    expect(gearGlyphFor(type)).toBe(glyph);
  });

  // the narrow name sits above the broad one it would otherwise lose to
  it.each([
    ["Sleeping bag liner", "quilt"],
    ["Down jacket", "puffy"],
    ["Insulated jacket", "puffy"],
    ["Neck gaiter", "neckGaiter"],
    ["Gaiters", "socks"],
    ["Fleece pants", "pants"],
    ["Fleece", "hoodie"],
    ["Fuel canister", "canister"],
    ["Bear canister", "jar"],
    ["Canister stand", "stove"],
    ["Bottle cap", "bottle"],
    ["Coffee filter", "cup"],
    ["Pill bottle", "pills"],
    ["Toiletry bottle", "tube"],
    ["Trucker hat", "cap"],
    ["Sun hat", "sunHat"],
    ["Phone case", "phone"],
    ["Toothbrush case", "tooth"],
    ["Pack liner", "dryBag"],
    ["Toiletry bag", "pouch"],
  ])("%s → %s, not the broader rule", (type, glyph) => {
    expect(gearGlyphFor(type)).toBe(glyph);
  });

  it("reads a typed type the same as the catalog's spelling", () => {
    expect(gearGlyphFor("  stuff   SACK ")).toBe("stuffSack");
    expect(gearGlyphFor("hiking boots")).toBe("shoes");
  });

  it("answers null rather than guessing", () => {
    expect(gearGlyphFor("Ice axe")).toBeNull();
    expect(gearGlyphFor("Earplugs")).toBeNull();
    expect(gearGlyphFor("")).toBeNull();
    expect(gearGlyphFor(null)).toBeNull();
    expect(gearGlyphFor(undefined)).toBeNull();
  });

  it("only ever answers a glyph the app has a drawing for", () => {
    const known = new Set<string>(GEAR_GLYPHS);
    for (const type of ["Tent", "Quilt", "Pouch", "Map", "Thermometer", "Bivy", "Lantern"]) {
      expect(known.has(gearGlyphFor(type)!)).toBe(true);
    }
  });

  // A floor, not a target: the catalog is where most gear types come from, and a new
  // research batch that adds a common type with no picture should say so here.
  it("gives a picture to at least 95% of the catalog's rows", () => {
    const [head, ...rows] = parseCsv(readFileSync(CATALOG_CSV, "utf8"));
    const col = head!.indexOf("common_name");
    const typed = rows.filter((r) => r[col]);
    const pictured = typed.filter((r) => gearGlyphFor(r[col]) !== null);
    expect(pictured.length / typed.length).toBeGreaterThanOrEqual(0.95);
  });
});
