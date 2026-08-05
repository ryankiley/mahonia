import { describe, expect, it } from "vitest";
import { listToText } from "../shared/exporters/text";
import type { ListSnapshot } from "../shared/types";

const snap = (): ListSnapshot => ({
  shareCode: "X",
  slug: "x",
  version: 1,
  isPublic: false,
  title: "Trip",
  displayUnit: "g",
  folders: [
    { id: "f1", name: "Shelter", defaultClassification: "base", sortOrder: 0 },
    { id: "f2", name: "On Body", defaultClassification: "worn", sortOrder: 1 },
  ],
  items: [
    { id: "i1", folderId: "f1", name: "Duplex", brand: "Zpacks", unitWeightMg: 538000, qty: 1, classification: null, sortOrder: 0 },
    { id: "i2", folderId: "f2", name: "Rain jacket", unitWeightMg: 300000, qty: 1, classification: null, sortOrder: 0 },
  ],
});

describe("listToText", () => {
  it("runs the items together as one comma-separated line, with no title or headings", () => {
    const out = listToText(snap());
    expect(out.split("\n\n")[0]).toBe("Zpacks Duplex, Rain jacket");
    // the things this format exists to shed
    expect(out).not.toContain("Trip");
    expect(out).not.toContain("Shelter");
    expect(out).not.toContain("|");
    expect(out).not.toContain("#");
  });

  it("keeps the app's visible order across folders, then ungrouped", () => {
    const s = snap();
    s.items.push({ id: "i3", folderId: null, name: "Loose thing", unitWeightMg: 0, qty: 1, classification: null, sortOrder: 0 });
    expect(listToText(s).split("\n\n")[0]).toBe("Zpacks Duplex, Rain jacket, Loose thing");
  });

  it("trails the gear type as a common noun when the name doesn't already carry it", () => {
    const s = snap();
    s.items[0]!.commonName = "Tent";
    // "Trail runners" → "trail runners": a capital mid-sentence reads as a proper noun
    s.items.push({ id: "i3", folderId: "f2", name: "Lone Peak 9+", brand: "Altra", commonName: "Trail runners", unitWeightMg: 300000, qty: 1, classification: null, sortOrder: 1 });
    const out = listToText(s);
    expect(out).toContain("Zpacks Duplex tent");
    expect(out).toContain("Altra Lone Peak 9+ trail runners");
  });

  it("leaves an acronym gear type alone rather than lowering its first letter", () => {
    const s = snap();
    s.items[0]!.commonName = "GPS";
    expect(listToText(s)).toContain("Zpacks Duplex GPS");
  });

  it("doesn't repeat a gear type the product name already says", () => {
    const s = snap();
    s.items[1]!.commonName = "Rain jacket";
    expect(listToText(s).split("\n\n")[0]).toBe("Zpacks Duplex, Rain jacket");
  });

  it("drops the variant — a size/config qualifier is noise in a sentence", () => {
    const s = snap();
    s.items[0]!.variant = "Regular, quilt + Fast Sheet";
    expect(listToText(s)).toContain("Zpacks Duplex,");
    expect(listToText(s)).not.toContain("Fast Sheet");
  });

  it("marks a quantity only above one", () => {
    const s = snap();
    s.items.push({ id: "i3", folderId: "f1", name: "Stakes", unitWeightMg: 8000, qty: 6, classification: null, sortOrder: 1 });
    const out = listToText(s);
    expect(out).toContain("Stakes ×6");
    expect(out).not.toContain("Rain jacket ×1");
  });

  it("flattens nested children in after their parent", () => {
    const s = snap();
    s.items.push({ id: "i3", folderId: "f1", parentId: "i1", name: "Fly", unitWeightMg: 200000, qty: 1, classification: null, sortOrder: 0 });
    expect(listToText(s).split("\n\n")[0]).toBe("Zpacks Duplex, Fly, Rain jacket");
  });

  it("closes with base and total, promoted to the unit that reads best", () => {
    // 538 g + 300 g stays in grams; the totals block is one sentence, not a list
    expect(listToText(snap())).toContain("Base weight 538 g, 838 g total");
    const s = snap();
    s.items[0]!.unitWeightMg = 5_380_000; // 5.38 kg — past the g→kg promotion
    expect(listToText(s)).toContain("Base weight 5.38 kg, 5.68 kg total");
  });

  it("stays in oz/lb for an imperial list", () => {
    const s = snap();
    s.displayUnit = "oz";
    // 838 g is past a pound, so the same promotion that takes metric g→kg takes this lb
    expect(listToText(s)).toContain("Base weight 1.19 lb, 1.85 lb total");
    // under a pound it stays in ounces rather than being forced up
    for (const it of s.items) it.unitWeightMg = 50_000;
    expect(listToText(s)).toContain("Base weight 1.8 oz, 3.5 oz total");
  });

  it("says nothing about weight when the list has none", () => {
    const s = snap();
    for (const it of s.items) it.unitWeightMg = 0;
    expect(listToText(s)).toBe("Zpacks Duplex, Rain jacket");
  });

  it("appends the caller's link, and only the caller's", () => {
    const withUrl = listToText(snap(), { shareUrl: "https://mahonia.app/s/X" });
    expect(withUrl).toContain("Base weight 538 g, 838 g total — full list at https://mahonia.app/s/X");
    // nothing is derived here: no link passed, no link in the output
    expect(listToText(snap())).not.toContain("mahonia.app");
  });

  it("capitalizes the tail even when the link is the only thing in it", () => {
    const s = snap();
    for (const it of s.items) it.unitWeightMg = 0;
    expect(listToText(s, { shareUrl: "https://mahonia.app/s/X" })).toContain(
      "\n\nFull list at https://mahonia.app/s/X",
    );
  });

  it("skips unnamed rows, and returns an empty string for an empty list", () => {
    const s = snap();
    s.items.push({ id: "i3", folderId: "f1", name: "   ", unitWeightMg: 0, qty: 1, classification: null, sortOrder: 1 });
    expect(listToText(s).split("\n\n")[0]).toBe("Zpacks Duplex, Rain jacket");

    const empty = snap();
    empty.items = [];
    expect(listToText(empty)).toBe("");
  });
});
