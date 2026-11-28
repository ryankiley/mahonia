import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { CATALOG_DDL } from "../server/utils/catalog";
import { claimLists } from "../server/utils/claimRepo";
import { LISTS_DDL, SNAPSHOTS_DDL } from "../server/utils/db";
import {
  applyOpsByEditHash,
  createList,
  exportClaimedLists,
  getByEditHash,
  getByShareCode,
  getCardByShareCode,
  getTextByShareCode,
  listSnapshotsByEditHash,
  restoreSnapshotByEditHash,
  rowToSnapshot,
} from "../server/utils/listRepo";
import { listToCsv } from "../shared/exporters/csv";
import { listToJson } from "../shared/exporters/json";
import { encodePolyline } from "../shared/polyline";
import type { ListRow } from "../server/db/schema";
import type { ListData, ListMeta } from "../shared/types";
import { seedCatalogRow } from "./helpers/catalog";
import { byToken, createTestDb, type TestDb } from "./helpers/db";
import { dbState } from "./helpers/dbMock";

// createList, getByEditHash and the share-code reads take no db argument
vi.mock("../server/utils/db", async (o) => (await import("./helpers/dbMock")).mockDbModule(o));

// The route's shape is the app's only stored geography, and it is not public.
//
// `trailProfile` is 240 elevation numbers with no position in them — genuinely anonymous
// terrain. A route is not the same object: a recorded track starts where the person
// parked, which is frequently where they live. And a waypoint is only a distance, which
// discloses nothing alone — but combined with the geometry it resolves to a precise point,
// so the two are ONE privacy object and travel together or not at all. Note the list also
// carries its dates, which makes a published camp pin a statement about where a named
// person will be sleeping on a given night.
//
// The protection is architectural: rowToSnapshot omits both, so every read path starts
// without them and has to ask. That is the wrong way round from how it reads, and it is
// the only shape that fails CLOSED — every share-code read builds on rowToSnapshot, and
// so will any read path added later.
//
// This file asserts BOTH halves, because the last time the app had a wrapper like this
// only the "doesn't leak" half was tested, and THREE owner paths quietly forgot to call
// it — including the autosave echo, which emptied the field on every save.

const GEOMETRY = encodePolyline([
  { lat: 45.33, lon: -121.71 },
  { lat: 45.34, lon: -121.7 },
]);

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
    trailProfile: "1000,1200,1100",
    trailAscentM: 500,
    trailDescentM: 400,
    routeGeometry: GEOMETRY,
    startDate: null,
    endDate: null,
    data: {
      folders: [],
      items: [
        { id: "i1", folderId: null, name: "Tent", qty: 1, sortOrder: 0, packed: true, priceCents: 28_900, currency: "USD" },
        { id: "i2", folderId: null, name: "Stove", qty: 1, sortOrder: 1, packed: false },
      ],
      days: [],
      waypoints: [{ id: "w1", kind: "camp", alongM: 6_200, label: "Cairn Basin" }],
    },
    totalWeightMg: 0,
    itemCount: 0,
    version: 1,
    updatedAt: new Date("2026-08-06T00:00:00Z"),
    ...over,
  }) as unknown as ListRow;

describe("a route never rides a read path", () => {
  it("rowToSnapshot omits the geometry and empties the waypoints", () => {
    const snap = rowToSnapshot(row());
    expect("routeGeometry" in snap).toBe(false);
    expect(snap.waypoints).toEqual([]);
    // …while the rest of the trail meta IS there, so this isn't passing by accident
    expect(snap.trailDistanceM).toBe(12_070);
    expect(snap.trailProfile).toBe("1000,1200,1100");
  });

  it("survives serialization — no coordinate, no label, no distance-along", () => {
    // JSON.stringify is what actually reaches a browser, and a present-but-undefined key
    // vanishes there too; `in` above catches the weaker version of the fix.
    const json = JSON.stringify(rowToSnapshot(row()));
    expect(json).not.toContain(GEOMETRY);
    expect(json).not.toContain("Cairn Basin");
    expect(json).not.toContain("6200");
  });

  it("and neither does the owner's packing progress", () => {
    // A tick is not a property of the gear — it is how far along somebody is with their
    // own packing, and it was riding every share link unrendered but plainly in the
    // payload. The ITEMS stay public; only the tick goes.
    const snap = rowToSnapshot(row());
    expect(snap.items).toHaveLength(2);
    expect(snap.items.map((i) => i.name)).toEqual(["Tent", "Stove"]);
    for (const item of snap.items) expect("packed" in item).toBe(false);
    expect(JSON.stringify(snap)).not.toContain("packed");
  });

  it("nor what the owner paid for it", () => {
    // A price comes onto a row with a piece picked from My Gear. No list surface shows
    // it, so on a share link it was only ever something a stranger could read out of
    // the payload, export, or carry into their own gear by duplicating the list.
    const snap = rowToSnapshot(row());
    expect(snap.items.map((i) => i.name)).toEqual(["Tent", "Stove"]);
    for (const item of snap.items) {
      expect("priceCents" in item).toBe(false);
      expect("currency" in item).toBe(false);
    }
    const json = JSON.stringify(snap);
    expect(json).not.toContain("28900");
    expect(json).not.toContain("USD");
  });

  it("the days beside them are still public, which is the point of the asymmetry", () => {
    const snap = rowToSnapshot(
      row({ data: { folders: [], items: [], days: [{ id: "d1", sortOrder: 0, distanceM: 16_093 }], waypoints: [] } } as Partial<ListRow>),
    );
    expect(snap.days).toHaveLength(1);
  });

  it("stays out of a JSON backup taken from a PUBLIC snapshot", () => {
    // /s does offer "Download JSON", and it runs on the public snapshot — so the
    // exporter carrying geometry deliberately is safe by construction, not by care
    const publicSnap = rowToSnapshot(row()) as unknown as ListMeta & ListData;
    const json = listToJson(publicSnap);
    expect(json).not.toContain(GEOMETRY);
    expect(json).not.toContain("Cairn Basin");
    expect(json).not.toContain("priceCents");
  });

  it("and a CSV taken from one has an empty Price column", () => {
    const csv = listToCsv(rowToSnapshot(row()));
    expect(csv).toContain("Tent");
    expect(csv).not.toContain("289");
  });
});

// Driven through the repo on a real database: every function that answers an edit
// capability or mints a list, since each one talks to an owner. A wrapper that is called
// by some of them and not others does not error anywhere. It hands the editor back a list
// with no route, and the client adopts that wholesale.
describe("…but the OWNER still gets it back", () => {
  const PIN = { id: "w1", kind: "camp", alongM: 600, label: "Cairn Basin" };
  const owned = {
    routeGeometry: GEOMETRY,
    waypoints: [PIN],
    items: [
      expect.objectContaining({ id: "i1", packed: true, priceCents: 28_900, currency: "USD" }),
      expect.objectContaining({ id: "i2", packed: true, priceCents: 26_000, currency: "CAD" }),
    ],
  };

  let db: TestDb;
  let editToken: string;
  let shareCode: string;
  let minted: unknown;

  beforeEach(async () => {
    db = dbState.db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL, CATALOG_DDL, ACCOUNT_DDL);
    // the catalog renamed this product after the list linked it
    const pack = await seedCatalogRow(db, { brand: "Durston", name: "Kakwa 55" });
    const made = await createList({
      title: "Trip",
      routeGeometry: GEOMETRY,
      data: {
        folders: [],
        items: [
          { id: "i1", name: "Tent", qty: 1, sortOrder: 0, packed: true, priceCents: 28_900, currency: "USD" },
          { id: "i2", name: "Kakwa 55 OLD", brand: "Durston", catalogItemId: pack.id, qty: 1, sortOrder: 1, packed: true, priceCents: 26_000, currency: "CAD" },
        ],
        days: [],
        waypoints: [PIN],
      } as unknown as ListData,
    });
    editToken = made.editToken;
    shareCode = made.snapshot.shareCode;
    minted = made.snapshot;
  });

  const edit = (ops: Parameters<typeof applyOpsByEditHash>[1]) => byToken(applyOpsByEditHash)(editToken, ops, db);

  it("on the list as it is minted, or a draft with a route loses it on its first save", () => {
    expect(minted).toMatchObject(owned);
  });

  it("on a read by edit link", async () => {
    expect(await byToken(getByEditHash)(editToken)).toMatchObject(owned);
  });

  it("on the autosave echo, which the editor adopts whole", async () => {
    expect(await edit([{ t: "updateItem", id: "i1", patch: { qty: 2 } }])).toMatchObject(owned);
  });

  it("on a restore, which writes them back over whatever is live", async () => {
    // the first edit records the list as minted; the second clears the route (and its
    // pins with it), unticks the tent and reprices it
    await edit([{ t: "updateItem", id: "i1", patch: { qty: 2 } }]);
    const cleared = await edit([
      { t: "setMeta", patch: { routeGeometry: "" } },
      { t: "updateItem", id: "i1", patch: { packed: false, priceCents: 100, currency: "EUR" } },
    ]);
    expect(cleared!.routeGeometry).toBeUndefined();
    expect(cleared!.waypoints).toEqual([]);

    const points = await byToken(listSnapshotsByEditHash)(editToken, db);
    const restored = await byToken(restoreSnapshotByEditHash)(editToken, points!.at(-1)!.id, db);
    expect(restored).toMatchObject(owned);
    // and it is the row that holds them, not only the answer
    expect(await byToken(getByEditHash)(editToken)).toMatchObject(owned);
  });

  it("in the account's takeout, since a claim is ownership", async () => {
    expect(await claimLists(db, 1, [editToken])).toBe(1);
    expect(await exportClaimedLists(db, 1)).toMatchObject([owned]);
  });

  it("beside the catalog's current name, which putting the tick back must not undo", async () => {
    // The owner's items are hydrated before the owner-only fields go back on. Restoring
    // those by replacing the items with the stored ones would revert every renamed
    // catalog product, on the owner's view only.
    const current = expect.objectContaining({ id: "i2", name: "Kakwa 55", packed: true, priceCents: 26_000, currency: "CAD" });
    expect((await byToken(getByEditHash)(editToken))!.items[1]).toEqual(current);
    expect((await edit([{ t: "updateItem", id: "i1", patch: { qty: 2 } }]))!.items[1]).toEqual(current);
    await claimLists(db, 1, [editToken]);
    expect((await exportClaimedLists(db, 1))[0]!.items[1]).toEqual(current);
  });

  it.each([
    ["the shared page", getByShareCode],
    ["its social card", getCardByShareCode],
    ["its Markdown twin", getTextByShareCode],
  ])("and a share-code reader of %s gets none of it", async (_name, read) => {
    const snap = (await read(shareCode))!;
    // the gear itself is public
    expect(snap.items.map((i) => i.id)).toEqual(["i1", "i2"]);
    expect("routeGeometry" in snap).toBe(false);
    expect(snap.waypoints).toEqual([]);
    const json = JSON.stringify(snap);
    for (const secret of [GEOMETRY, "Cairn Basin", "packed", "priceCents", "currency", "28900", "26000"])
      expect(json).not.toContain(secret);
  });
});
