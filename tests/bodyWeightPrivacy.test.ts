import { describe, expect, it } from "vitest";
import { rowToSnapshot } from "../server/utils/listRepo";
import { listToJson } from "../shared/exporters/json";
import type { ListRow } from "../server/db/schema";
import type { ListMeta, ListData } from "../shared/types";

// Body weight is the one field on a list that a viewer must never see. It is health-
// adjacent, and a list travels by URL — a read link, an edit link, the public feed, a
// JSON backup someone emails around.
//
// The protection is ARCHITECTURAL: rowToSnapshot omits it, and only the editor's own
// read path adds it back. These tests exist because that is exactly the kind of guarantee
// that rots quietly — the field is optional, so every one of those paths compiles just
// fine whether or not it leaks.

const row = (over: Partial<ListRow> = {}) =>
  ({
    id: 1,
    publicSlug: "trip-a1b2c3",
    editTokenHash: "hash",
    shareCode: "ABC123",
    title: "Trip",
    description: null,
    displayUnit: "g",
    trailUrl: null,
    trailLabel: null,
    trailDistanceM: 12_070,
    trailDistanceUnit: "km",
    bodyWeightG: 82_000,
    bodyWeightUnit: "kg",
    startDate: null,
    endDate: null,
    data: { folders: [], items: [], days: [] },
    baseWeightMg: 0,
    wornWeightMg: 0,
    consumableWeightMg: 0,
    totalWeightMg: 0,
    itemCount: 0,
    isPublic: false,
    version: 1,
    updatedAt: new Date("2026-08-05T00:00:00Z"),
    ...over,
  }) as unknown as ListRow;

describe("body weight never rides a read path", () => {
  it("rowToSnapshot omits it, even though the row has it", () => {
    const snap = rowToSnapshot(row());
    expect(snap.bodyWeightG).toBeUndefined();
    expect(snap.bodyWeightUnit).toBeUndefined();
    // …while the rest of the trail meta is right there, so this isn't passing by accident
    expect(snap.trailDistanceM).toBe(12_070);
  });

  it("has no such key at all — not merely undefined", () => {
    // `JSON.stringify` is what actually reaches a browser, and a present-but-undefined
    // key would vanish there too. Checking `in` catches the weaker version of the fix.
    const snap = rowToSnapshot(row());
    expect("bodyWeightG" in snap).toBe(false);
    expect("bodyWeightUnit" in snap).toBe(false);
    expect(JSON.stringify(snap)).not.toContain("82000");
    expect(JSON.stringify(snap)).not.toContain("bodyWeight");
  });

  it("stays out of a JSON backup", () => {
    // a backup is a file people mail to each other
    const list = {
      title: "Trip",
      displayUnit: "g",
      bodyWeightG: 82_000,
      bodyWeightUnit: "kg",
      folders: [],
      items: [],
      days: [],
    } as unknown as ListMeta & ListData;
    const json = listToJson(list);
    expect(json).not.toContain("bodyWeight");
    expect(json).not.toContain("82000");
  });

  it("is still absent when the row carries no body weight — the null case", () => {
    const snap = rowToSnapshot(row({ bodyWeightG: null, bodyWeightUnit: null } as Partial<ListRow>));
    expect("bodyWeightG" in snap).toBe(false);
  });
});
