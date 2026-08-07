import { describe, expect, it } from "vitest";
import { rowToSnapshot } from "../server/utils/listRepo";
import type { ListRow } from "../server/db/schema";

const CURLY = String.fromCharCode(0x2019);

// A row exactly as the database held it BEFORE the tidy shipped: straight apostrophes,
// doubled spaces, untrimmed ends. Nothing rewrites these in place, so the read path is
// the only thing standing between them and the screen.
const legacyRow = () =>
  ({
    shareCode: "abc123",
    publicSlug: "ryans-trip-abc123",
    title: "  Ryan's   Timberline ",
    description: "A trip.\n\nWith paragraphs, and Ryan's notes.",
    trailUrl: "https://www.alltrails.com/trail/us/california/mount-si",
    trailLabel: "  Ryan's  loop ",
    startDate: null,
    endDate: null,
    displayUnit: "g",
    version: 7,
    isPublic: true,
    updatedAt: new Date("2025-01-02T03:04:05Z"),
    data: {
      folders: [
        { id: "f1", name: "Men's  layers", defaultClassification: "base", sortOrder: 0 },
      ],
      items: [
        {
          id: "i1",
          folderId: "f1",
          name: "  Ryan's  tent ",
          brand: "Arc'teryx",
          variant: "Men's  Regular",
          commonName: " tent ",
          description: "Ryan's  spare",
          productUrl: "https://example.com/men's-jacket",
          unitWeightMg: 538000,
          qty: 1,
          classification: null,
          sortOrder: 0,
        },
        {
          id: "i2",
          folderId: null,
          name: "Guyline 6'",
          description: `2" stakes`,
          unitWeightMg: 1000,
          qty: 1,
          classification: null,
          sortOrder: 1,
        },
      ],
    },
  }) as unknown as ListRow;

describe("a list stored before the tidy existed", () => {
  it("comes out of the read path fully tidied, top to bottom", () => {
    const snap = rowToSnapshot(legacyRow());
    expect(snap.title).toBe(`Ryan${CURLY}s Timberline`);
    expect(snap.trailLabel).toBe(`Ryan${CURLY}s loop`);
    expect(snap.folders[0]!.name).toBe(`Men${CURLY}s layers`);
    expect(snap.items[0]!.name).toBe(`Ryan${CURLY}s tent`);
    expect(snap.items[0]!.brand).toBe(`Arc${CURLY}teryx`);
    expect(snap.items[0]!.variant).toBe(`Men${CURLY}s Regular`);
    expect(snap.items[0]!.commonName).toBe("tent");
    expect(snap.items[0]!.description).toBe(`Ryan${CURLY}s spare`);
  });

  it("leaves no straight apostrophe anywhere a reader can see one", () => {
    const snap = rowToSnapshot(legacyRow());
    const visible = [
      snap.title,
      snap.trailLabel ?? "",
      ...snap.folders.map((f) => f.name),
      ...snap.items.flatMap((i) => [i.name, i.brand ?? "", i.variant ?? "", i.commonName ?? ""]),
    ].join(" | ");
    // the only survivor is the foot mark, which is a measurement and not an apostrophe
    expect(visible).toContain("Guyline 6'");
    expect(visible.replace("Guyline 6'", "")).not.toContain("'");
  });

  it("still doesn't touch the things the write path won't touch", () => {
    const snap = rowToSnapshot(legacyRow());
    expect(snap.items[0]!.productUrl).toBe("https://example.com/men's-jacket");
    expect(snap.items[1]!.name).toBe("Guyline 6'");
    expect(snap.items[1]!.description).toBe(`2" stakes`);
  });

  it("curls the list description's apostrophes but keeps its paragraphs", () => {
    const snap = rowToSnapshot(legacyRow());
    // it renders directly under the title, so it has to agree with it…
    expect(snap.description).toBe(`A trip.\n\nWith paragraphs, and Ryan${CURLY}s notes.`);
    // …but this is the one field with no editor and real line structure, so the
    // break survives and a JSON backup still round-trips it (tidyProse, not tidyText)
    expect(snap.description!.split("\n").length).toBe(3);
  });

  it("carries every non-text field through unchanged", () => {
    const snap = rowToSnapshot(legacyRow());
    expect(snap.shareCode).toBe("abc123");
    expect(snap.version).toBe(7);
    expect(snap.isPublic).toBe(true);
    expect(snap.displayUnit).toBe("g");
    expect(snap.items[0]!.unitWeightMg).toBe(538000);
    expect(snap.updatedAt).toBe("2025-01-02T03:04:05.000Z");
  });

  it("is stable when the same row is read twice", () => {
    expect(rowToSnapshot(legacyRow())).toEqual(rowToSnapshot(legacyRow()));
  });
});
