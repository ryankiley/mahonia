import { readFileSync } from "node:fs";
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

// The OTHER half of the invariant, and the half whose absence let three real bugs ship.
//
// Everything above proves body weight doesn't leak. None of it proves the owner still
// GETS it — and because rowToSnapshot fails closed, an owner path that forgets
// withOwnerOnly is silently wrong rather than loudly wrong. Three did: create, restore,
// and the autosave echo, which handed the editor back a list with no body weight on every
// single save and emptied the field the user had just filled in.
//
// This reads the source because the real thing needs a database. That's a fair trade: the
// failure mode is a call site that forgot a wrapper, and a call site that forgot a wrapper
// is exactly what source can see.
describe("…but the owner still gets it back", () => {
  const src = readFileSync(new URL("../server/utils/listRepo.ts", import.meta.url), "utf8");

  // every function that answers an edit token or mints a list — i.e. talks to an owner
  const OWNER_PATHS = [
    "getByEditToken",
    "createList",
    "applyOpsByEditToken",
    "restoreSnapshotByEditToken",
  ];

  const bodyOf = (name: string) => {
    const start = src.search(new RegExp(`(export )?(async )?function ${name}\\b`));
    expect(start, `${name} not found in listRepo.ts`).toBeGreaterThan(-1);
    // to the start of the next top-level declaration, which is close enough to a body
    const rest = src.slice(start + 1);
    const end = rest.search(/\n(export )?(async )?function /);
    return end === -1 ? rest : rest.slice(0, end);
  };

  it.each(OWNER_PATHS)("%s carries the owner-only fields", (name) => {
    const body = bodyOf(name);
    expect(body).toContain("rowToSnapshot");
    expect(body).toContain("withOwnerOnly");
  });

  it("and withOwnerOnly is the only thing that ever sets them", () => {
    // If a second place starts writing bodyWeightG onto a snapshot, the guarantee stops
    // being one line and starts being a habit. Assignments in this file should be the
    // two inside withOwnerOnly and nowhere else.
    const assignments = src.match(/\.bodyWeight(G|Unit)\s*=/g) ?? [];
    expect(assignments).toHaveLength(2);
  });
});
