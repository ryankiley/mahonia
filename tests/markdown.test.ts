import { describe, expect, it } from "vitest";
import { listToMarkdown } from "../shared/exporters/markdown";
import { sampleSnapshot as snap } from "./helpers/list";

describe("listToMarkdown", () => {
  it("renders a heading, a table per non-empty folder, and a totals block", () => {
    const md = listToMarkdown(snap());
    expect(md).toContain("# Trip");
    expect(md).toContain("## Shelter");
    expect(md).toContain("| Item | Qty | Weight |");
    expect(md).toContain("| Zpacks Duplex | 1 | 538 g |");
    expect(md).toContain("**Total:**");
  });

  it("annotates a worn split in the qty cell and splits the totals", () => {
    const s = snap();
    s.items.push({ id: "i3", folderId: "f1", name: "Socks", unitWeightMg: 100000, qty: 3, wornQty: 1, classification: null, sortOrder: 1 });
    const md = listToMarkdown(s);
    expect(md).toContain("| Socks | 3 (1 worn) | 300 g |");
    expect(md).toContain("**Worn:** 400 g"); // 300g jacket + 1×100g sock
    expect(md).toContain("**Base weight:** 738 g"); // duplex + 2×100g socks
  });

  it("adds a Carried line once the list has both worn and consumable weight", () => {
    const s = snap();
    // the base snapshot is base + worn only, so Carried would just restate Base
    expect(listToMarkdown(s)).not.toContain("**Carried:**");

    s.folders.push({ id: "f3", name: "Food", defaultClassification: "consumable", sortOrder: 2 });
    s.items.push({ id: "i4", folderId: "f3", name: "Bars", unitWeightMg: 60000, qty: 5, classification: null, sortOrder: 0 });
    const md = listToMarkdown(s);
    expect(md).toContain("**Carried:** 838 g"); // 538 g duplex + 300 g bars
    expect(md).toContain("**Total:** 1,138 g"); // + the 300 g worn jacket
  });

  it("trails the common name after the product name in the Item cell", () => {
    const s = snap();
    s.items[0]!.commonName = "Tent";
    const md = listToMarkdown(s);
    expect(md).toContain("| Zpacks Duplex — Tent | 1 | 538 g |");
    // an item without a common name is unchanged
    expect(md).toContain("| Rain jacket | 1 | 300 g |");
  });

  it("falls back to a default title and skips empty folders", () => {
    const s = snap();
    s.title = "";
    s.items = s.items.filter((i) => i.folderId === "f1"); // f2 now empty
    const md = listToMarkdown(s);
    expect(md).toContain("# Mahonia list");
    expect(md).toContain("## Shelter");
    expect(md).not.toContain("## On Body");
  });

  it("emits ungrouped items in a trailing Ungrouped table and honors folder sortOrder over array order", () => {
    const s = snap();
    // folder drag-reorder only rewrites sortOrder — the stored array keeps
    // insertion order, so the export must sort, not trust the array
    s.folders[0]!.sortOrder = 1;
    s.folders[1]!.sortOrder = 0;
    s.items.push({ id: "i6", folderId: null, name: "Loose spork", unitWeightMg: 18000, qty: 1, classification: null, sortOrder: 0 });
    const md = listToMarkdown(s);
    const headings = md.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual(["## On Body", "## Shelter", "## Ungrouped"]);
    expect(md).toContain("| Loose spork | 1 | 18 g |");
    // the tables must account for every item computeTotals sums
    expect(md).toContain("**Total:** 856 g"); // 538 + 300 + 18
  });

  it("omits the Ungrouped table when every item has a folder", () => {
    expect(listToMarkdown(snap())).not.toContain("## Ungrouped");
  });
});
