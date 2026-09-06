import { describe, expect, it } from "vitest";
import { DRAFT_KEY, localKey } from "../shared/localList";
import { rebaseOnto } from "../shared/ops";
import type { ListSnapshot } from "../shared/types";

// A small authoritative snapshot, as the server would return it.
const server = (): ListSnapshot => ({
  title: "Trip",
  description: "",
  displayUnit: "g",
  folders: [{ id: "f1", name: "Shelter", defaultClassification: "base", sortOrder: 0 }],
  items: [
    { id: "i1", folderId: "f1", name: "Tent", unitWeightMg: 1000, qty: 1, classification: null, sortOrder: 0 },
  ],
  shareCode: "abc",
  slug: "trip",
  version: 3,
  isPublic: false,
});

describe("localKey", () => {
  it("keys a saved list by its edit token", () => {
    expect(localKey("tok_123")).toBe("tok_123");
  });
  it("falls back to the draft slot before a list has a token", () => {
    expect(localKey("")).toBe(DRAFT_KEY);
  });
});

describe("rebaseOnto", () => {
  it("returns the server snapshot untouched when there are no pending ops", () => {
    const s = server();
    expect(rebaseOnto(s, [])).toBe(s);
  });

  it("replays un-acked local ops on top without mutating the server snapshot", () => {
    const s = server();
    const merged = rebaseOnto(s, [
      { t: "updateItem", id: "i1", patch: { unitWeightMg: 2000 } },
      {
        t: "addItem",
        item: { id: "i2", folderId: "f1", name: "Stakes", unitWeightMg: 50, qty: 6, classification: null, sortOrder: 1 },
      },
    ]);

    // server input is left as-is (rebase clones before applying)
    expect(merged).not.toBe(s);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]!.unitWeightMg).toBe(1000);

    // merged carries the device's edits on top of the authoritative state
    expect(merged.items).toHaveLength(2);
    expect(merged.items[0]!.unitWeightMg).toBe(2000);
    expect(merged.items[1]!.name).toBe("Stakes");
    expect(merged.version).toBe(3); // server version is authoritative
  });

  it("merges gracefully when a pending op targets a row the server already dropped", () => {
    const s = server();
    // i9 was removed server-side (concurrent edit); updating it must be a no-op, not a throw
    const merged = rebaseOnto(s, [{ t: "updateItem", id: "i9", patch: { qty: 4 } }]);
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0]!.id).toBe("i1");
  });
});
