import { describe, expect, it } from "vitest";
import { listToMarkdown } from "../shared/exporters/markdown";
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
    { id: "i1", folderId: "f1", name: "Zpacks Duplex", unitWeightMg: 538000, qty: 1, classification: null, sortOrder: 0 },
    { id: "i2", folderId: "f2", name: "Rain jacket", unitWeightMg: 300000, qty: 1, classification: null, sortOrder: 0 },
  ],
});

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

  it("falls back to a default title and skips empty folders", () => {
    const s = snap();
    s.title = "";
    s.items = s.items.filter((i) => i.folderId === "f1"); // f2 now empty
    const md = listToMarkdown(s);
    expect(md).toContain("# Mahonia list");
    expect(md).toContain("## Shelter");
    expect(md).not.toContain("## On Body");
  });
});
