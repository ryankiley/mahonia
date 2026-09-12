import { describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { claimLists } from "../server/utils/claimRepo";
import { LISTS_DDL } from "../server/utils/db";
import { exportClaimedLists } from "../server/utils/listRepo";
import { CATALOG_DDL } from "../server/utils/catalog";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { EVERYTHING_FORMAT, everythingExport, listExportObject } from "../shared/exporters/everything";
import { jsonToListImport, listToJson } from "../shared/exporters/json";
import { vaultToJson } from "../shared/exporters/vault";
import { encodePolyline } from "../shared/polyline";
import type { ListSnapshot } from "../shared/types";
import type { VaultEntry, VaultFolder } from "../shared/vault";
import { createTestDb, makeList } from "./helpers/db";

// The account takeout: every claimed list as the OWNER holds it, in the shape a list's
// own backup has, plus the gear in the shape its own export has.

const GEOMETRY = encodePolyline([
  { lat: 45.33, lon: -121.71 },
  { lat: 45.34, lon: -121.7 },
]);

describe("exportClaimedLists", () => {
  it("returns the account's live claimed lists with the owner-only fields, newest first, and nobody else's", async () => {
    const db = await createTestDb(LISTS_DDL, ACCOUNT_DDL, VAULT_DDL, CATALOG_DDL);
    const mine = await makeList(db, "Timberline", {
      routeGeometry: GEOMETRY,
      data: {
        folders: [],
        items: [{ id: "i1", folderId: null, name: "Tent", unitWeightMg: 1_000_000, qty: 1, classification: null, sortOrder: 0, packed: true }],
        waypoints: [{ id: "w1", kind: "water", alongM: 500, label: "Spring" }],
      },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const newer = await makeList(db, "Wonderland", { createdAt: new Date("2026-02-01T00:00:00Z"), updatedAt: new Date("2026-02-01T00:00:00Z") });
    const theirs = await makeList(db, "Someone else's", { createdAt: new Date("2026-03-01T00:00:00Z") });
    const gone = await makeList(db, "Deleted", { createdAt: new Date("2026-03-01T00:00:00Z"), deletedAt: new Date() });
    // a deleted list can't be claimed at all (findLiveByEditHashes filters it), so two
    // of the three tokens take; the export must agree with that
    expect(await claimLists(db as never, 1, [mine.editToken, newer.editToken, gone.editToken])).toBe(2);
    expect(await claimLists(db as never, 2, [theirs.editToken])).toBe(1);

    const out = await exportClaimedLists(db as never, 1);
    expect(out.map((l) => l.title)).toEqual(["Wonderland", "Timberline"]);
    const t = out[1]!;
    expect(t.shareCode).toBe(mine.shareCode);
    // the owner's fields, which no share read carries
    expect(t.routeGeometry).toBe(GEOMETRY);
    expect(t.waypoints).toEqual([{ id: "w1", kind: "water", alongM: 500, label: "Spring" }]);
    expect(t.items[0]!.packed).toBe(true);
    // and never an edit token or its hash
    expect(JSON.stringify(out)).not.toMatch(/editToken|editTokenHash|edit_token/);
  });

  it("is empty for an account with no claims", async () => {
    const db = await createTestDb(LISTS_DDL, ACCOUNT_DDL, VAULT_DDL, CATALOG_DDL);
    await makeList(db, "Unclaimed");
    expect(await exportClaimedLists(db as never, 7)).toEqual([]);
  });
});

describe("the takeout's shape", () => {
  const snap = (over: Partial<ListSnapshot> = {}): ListSnapshot => ({
    shareCode: "ABC123DEF456",
    slug: "trip-a1b2c3",
    version: 3,
    isPublic: false,
    updatedAt: "2026-06-01T00:00:00.000Z",
    title: "Trip",
    displayUnit: "g",
    startDate: "2026-06-20",
    routeGeometry: GEOMETRY,
    trailDistanceM: 1_500,
    folders: [{ id: "f1", name: "Shelter", defaultClassification: "base", sortOrder: 0 }],
    items: [{ id: "i1", folderId: "f1", name: "Duplex", brand: "Zpacks", unitWeightMg: 538_000, qty: 1, classification: null, sortOrder: 0, packed: true }],
    days: [{ id: "d1", sortOrder: 0, distanceM: 1_500 }],
    waypoints: [{ id: "w1", kind: "water", alongM: 500, label: "Spring" }],
    people: [{ id: "p1", name: "Sam", colorKey: "shelter", sortOrder: 0 }],
    ...over,
  });
  const gear = {
    folders: [{ id: 1, name: "Sleep", sortOrder: 0 } as unknown as VaultFolder],
    items: [{ id: 5, normKey: "zpacks duplex", name: "Duplex", brand: "Zpacks", weightMg: 538_000, folderId: 1, timesSeen: 3 } as unknown as VaultEntry],
  };

  it("names its format, and holds each list in the backup's own shape plus its handle", () => {
    const out = everythingExport([snap()], gear, "2026-09-12T00:00:00.000Z");
    expect(out).toMatchObject({ format: EVERYTHING_FORMAT, version: 1, exportedAt: "2026-09-12T00:00:00.000Z" });
    expect(out.lists).toHaveLength(1);
    const list = out.lists[0]!;
    expect(list.shareCode).toBe("ABC123DEF456");
    expect(list.updatedAt).toBe("2026-06-01T00:00:00.000Z");
    // the backup's own keys, in its order, follow the two handle keys
    const backup = JSON.parse(listToJson(snap())) as Record<string, unknown>;
    const { shareCode: _c, updatedAt: _u, ...rest } = list;
    expect(Object.keys(rest)).toEqual(Object.keys(backup));
    expect(rest).toEqual(backup);
  });

  it("holds the gear in exactly the shape its own export writes", () => {
    const out = everythingExport([], gear, "2026-09-12T00:00:00.000Z");
    expect(out.gear).toEqual(JSON.parse(vaultToJson(gear)));
  });

  it("a list cut out of it restores through the importer, owner fields and all", () => {
    const list = listExportObject(snap());
    const restored = jsonToListImport(JSON.stringify(list))!;
    expect(restored).not.toBeNull();
    expect(restored.title).toBe("Trip");
    expect(restored.routeGeometry).toBe(GEOMETRY);
    expect(restored.startDate).toBe("2026-06-20");
    expect(restored.data.items[0]).toMatchObject({ name: "Duplex", brand: "Zpacks", packed: true });
    expect(restored.data.waypoints![0]).toMatchObject({ kind: "water", alongM: 500, label: "Spring" });
    expect(restored.data.people![0]).toMatchObject({ name: "Sam" });
  });

  it("carries no edit capability and no version, which belong to the row, not the file", () => {
    const list = listExportObject(snap());
    expect("version" in list).toBe(false);
    expect("isPublic" in list).toBe(false);
    expect("slug" in list).toBe(false);
    expect(JSON.stringify(list)).not.toMatch(/editToken/);
  });
});
