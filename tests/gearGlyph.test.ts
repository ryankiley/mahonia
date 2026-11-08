import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GEAR_FAMILIES, GEAR_GLYPHS, gearFamilyOf, gearGlyphFor } from "../shared/gearGlyph";
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
    ["Earplugs", "sleep"],
    ["Hammock", "sleep"],
    ["Mouth guard", "sleep"],
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
    ["Hiking boots", "boot"],
    ["Beanie", "hat"],
    ["Water bottle", "bottle"],
    ["Soft flask", "bottle"],
    ["Water reservoir", "hydration"],
    ["Hydration bladder", "hydration"],
    ["Water filter", "filter"],
    ["Stove", "stove"],
    ["Fuel canister", "stove"],
    ["Cup", "cup"],
    ["Spork", "utensils"],
    ["Energy bar", "food"],
    ["Meal", "meal"],
    ["Breakfast bar", "food"],
    ["Towel", "towel"],
    ["Underwear", "underwear"],
    ["Wallet", "wallet"],
    ["Repair kit", "repair"],
    ["Guyline", "cord"],
    ["Bear canister", "container"],
    ["Microspikes", "boot"],
    ["Hose", "hydration"],
    ["Tube clip", "hydration"],
    ["Electrolyte mix", "hydration"],
    ["Drink mix", "hydration"],
    ["Squeeze bottle", "bottle"],
    ["Compression straps", "bag"],
    ["Insoles", "shoe"],
    ["Head net", "bug"],
    ["Headlamp", "light"],
    ["GPS watch", "watch"],
    ["Power bank", "electronics"],
    ["Air pump", "electronics"],
    ["Earbuds", "earbuds"],
    ["Camp chair", "chair"],
    ["Carabiner", "carabiner"],
    ["Card game", "games"],
    ["Sunscreen", "toiletry"],
    ["Toothbrush", "toiletry"],
    ["Trowel", "toilet"],
    ["Wipes", "toilet"],
    ["First aid kit", "firstAid"],
    ["Ice axe", "iceAxe"],
  ])("%s → %s", (type, glyph) => {
    expect(gearGlyphFor(type)).toBe(glyph);
  });

  // the narrow name sits above the broad one it would otherwise lose to
  it.each([
    ["Neck gaiter", "neck"],
    ["Bandana", "neck"],
    ["Gaiters", "boot"],
    ["Running vest", "backpack"],
    ["Vest", "jacket"],
    ["Fleece pants", "pants"],
    ["Bottle cap", "bottle"],
    ["Stake bag", "bag"],
    ["Coffee filter", "cup"],
    ["Fuel bottle", "stove"],
    ["Tent poles", "tent"],
    ["Bug net", "bug"],
    ["Emergency blanket", "firstAid"],
    ["E-reader", "phone"],
    ["Hip belt", "backpack"],
    ["Pee funnel", "toilet"],
    ["Pill bottle", "firstAid"],
    ["Toiletry bottle", "toiletry"],
    ["Phone case", "phone"],
    ["Camera case", "camera"],
    ["Toothbrush case", "toiletry"],
    ["Pack liner", "bag"],
    ["Toiletry bag", "bag"],
    ["Face wipe", "toiletry"],
    ["Face wipes", "toiletry"],
  ])("%s → %s, not the broader rule", (type, glyph) => {
    expect(gearGlyphFor(type)).toBe(glyph);
  });

  it("falls back to the name only when the row has no type", () => {
    expect(gearGlyphFor(null, "Deodorant")).toBe("toiletry");
    expect(gearGlyphFor(null, "Relief Sun: Rice + Probiotics SPF50+")).toBe("toiletry");
    expect(gearGlyphFor("", "Meals - Dinner")).toBe("meal");
    expect(gearGlyphFor(undefined, "Snacks - Daily")).toBe("food");
    expect(gearGlyphFor("  ", "Baggies Brimmer Hat")).toBe("hat");
    expect(gearGlyphFor(null, "Face cleanser + Face Moisturizer + Container")).toBe("toiletry");
    // a type that matched nothing is still the row's answer
    expect(gearGlyphFor("Umbrella", "Summit Pro Hat")).toBeNull();
    // and a type that did match is never second-guessed by the name
    expect(gearGlyphFor("Socks", "Hiker Boot Midweight")).toBe("socks");
  });

  it("reads a plural the way it reads the singular", () => {
    expect(gearGlyphFor("Bungee cords")).toBe("cord");
    expect(gearGlyphFor("Pouches")).toBe("bag");
    expect(gearGlyphFor("Stuff sacks")).toBe("bag");
    // a word that only looks plural is left alone, so the long tail stays blank
    expect(gearGlyphFor("Compass")).toBeNull();
  });

  it("reads a typed type the same as the catalog's spelling", () => {
    expect(gearGlyphFor("  stuff   SACK ")).toBe("bag");
    expect(gearGlyphFor("hiking boots")).toBe("boot");
  });

  // the long tail goes without: a one-off icon is a picture to decode
  it("answers null for the long tail rather than giving it a one-off icon", () => {
    for (const type of ["Compass", "Umbrella", "Whistle", "Packraft"]) {
      expect(gearGlyphFor(type)).toBeNull();
    }
    expect(gearGlyphFor("")).toBeNull();
    expect(gearGlyphFor(null)).toBeNull();
    expect(gearGlyphFor(undefined)).toBeNull();
  });

  it("keeps the set small", () => {
    expect(GEAR_GLYPHS.length).toBeLessThanOrEqual(48);
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

describe("the families My Gear groups by", () => {
  it("puts every icon in exactly one family, in the set's own order", () => {
    expect(GEAR_FAMILIES.flatMap((f) => [...f.glyphs])).toEqual([...GEAR_GLYPHS]);
  });

  it("reads a piece's family off its icon, and none for no icon", () => {
    expect(gearFamilyOf(gearGlyphFor("Tent"))).toBe("shelter");
    expect(gearFamilyOf(gearGlyphFor("Stove"))).toBe("kitchen");
    expect(gearFamilyOf(gearGlyphFor("Rain jacket"))).toBe("clothing");
    expect(gearFamilyOf(null)).toBeNull();
  });
});
