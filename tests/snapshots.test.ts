import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { lists } from "../server/db/schema";
import { LISTS_DDL, SNAPSHOTS_DDL } from "../server/utils/db";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import {
  applyOpsByEditHash,
  listSnapshotsByEditHash,
  restoreSnapshotByEditHash,
} from "../server/utils/listRepo";
import { encodePolyline } from "../shared/polyline";
import type { Item, ListData, Waypoint } from "../shared/types";
import { byToken, createTestDb, makeList, type TestDb } from "./helpers/db";
import { folder as listFolder, item as listItem } from "./helpers/list";

const applyOpsByEditToken = byToken(applyOpsByEditHash);
const listSnapshotsByEditToken = byToken(listSnapshotsByEditHash);
const restoreSnapshotByEditToken = byToken(restoreSnapshotByEditHash);

/** A list holding `data`, its rows counted, at version 1. */
const seedList = (db: TestDb, data: ListData, title = "Orig", extra: Partial<typeof schema.lists.$inferInsert> = {}) =>
  makeList(db, title, { data, itemCount: data.items.length, version: 1, ...extra });

const folder = listFolder({ colorKey: "shelter" });
const item = (id: string, name: string): Item =>
  listItem({ id, name, unitWeightMg: 1000, weightOverridden: false, packed: false });

describe("snapshots — vandalism recovery", () => {
  it("auto-snapshots the pre-edit state, throttled to one per window", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { editToken } = await seedList(db, { folders: [folder], items: [item("i1", "Tent")] });
    await applyOpsByEditToken(editToken, [{ t: "updateItem", id: "i1", patch: { name: "Tent v2" } }], db);
    let snaps = await listSnapshotsByEditToken(editToken, db);
    expect(snaps).toHaveLength(1);
    // `reason` carries a SUMMARY of the batch now, not the constant "edit" — see
    // shared/changeSummary. This is what the sharing menu renders, so pinning it
    // here is what stops it silently regressing to a bare "Edited".
    //
    // It NAMES the row, which is only possible because this path hands the summary
    // the list as it stood before the ops were applied. Pinned end-to-end here (not
    // just in changeSummary's own unit tests) because the pre-edit state has to be
    // copied per-row: applyOps updates in place, so passing the live array would
    // compare the new name against itself and quietly report nothing at all.
    expect(snaps![0]!.reason).toBe("Renamed Tent → Tent v2");
    // a second mutate within the throttle window adds no new snapshot
    await applyOpsByEditToken(editToken, [{ t: "updateItem", id: "i1", patch: { name: "Tent v3" } }], db);
    snaps = await listSnapshotsByEditToken(editToken, db);
    expect(snaps).toHaveLength(1);
  });

  // The summary is words about a write that has ALREADY landed: it is worked out after
  // the save, from ops a client sent. So nothing an op can hold may make it throw: the
  // list would be saved and the request answered with an error, and the editor would
  // send the same batch again. A name that can't be read as text is one such op.
  it("saves and answers normally when a batch can't be summarized, with a plain reason", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { editToken } = await seedList(db, { folders: [folder], items: [item("i1", "Tent")] });
    // no id, so the reducer passes over it; the summary still reads its name
    const unreadable = { t: "addItem", item: { name: { toString: 1 } } } as never;

    const saved = await applyOpsByEditToken(editToken, [{ t: "updateItem", id: "i1", patch: { name: "Tent v2" } }, unreadable], db);
    // the answer is the saved list, the valid op applied
    expect(saved!.items.find((i) => i.id === "i1")!.name).toBe("Tent v2");
    const [row] = await db.select().from(lists);
    expect(row!.version).toBe(2);
    // and the point before it is there to go back to, described as plainly as it can be
    const snaps = await listSnapshotsByEditToken(editToken, db);
    expect(snaps!.map((s) => s.reason)).toEqual(["edit"]);
  });

  // An edit through the connector always leaves a point, named as an assistant's, so
  // it shows in recent changes and restoring that point undoes it. A burst of calls is
  // one entry: otherwise five quick calls would push every earlier point out of the cap.
  it("records an assistant's edit whatever the throttle says, once per burst", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { editToken } = await seedList(db, { folders: [folder], items: [item("i1", "Tent")] });
    await applyOpsByEditToken(editToken, [{ t: "updateItem", id: "i1", patch: { name: "Tent v2" } }], db);
    // inside the window: the owner's next edit would be skipped, the assistant's isn't
    await applyOpsByEditToken(
      editToken,
      [{ t: "addItem", item: item("i2", "Stakes") }],
      db,
      { actor: "assistant" },
    );
    let snaps = await listSnapshotsByEditToken(editToken, db);
    expect(snaps!.map((s) => [s.reason, s.by])).toEqual([
      ["Added Stakes", { kind: "assistant" }],
      ["Renamed Tent → Tent v2", null],
    ]);
    // the same assistant again, straight after: still one entry for it
    await applyOpsByEditToken(editToken, [{ t: "addItem", item: item("i3", "Pot") }], db, { actor: "assistant" });
    snaps = await listSnapshotsByEditToken(editToken, db);
    expect(snaps).toHaveLength(2);
    // and the owner, inside the window, is throttled as before
    await applyOpsByEditToken(editToken, [{ t: "updateItem", id: "i1", patch: { name: "Tent v3" } }], db);
    snaps = await listSnapshotsByEditToken(editToken, db);
    expect(snaps).toHaveLength(2);
  });

  // Who made a change: "You" to the person who made it, the name they chose to
  // everyone else, and nothing for an account without one or an edit link used
  // signed out. The session is only read when a point is actually taken.
  it("names who made a change to whoever reads it, and asks who only when it records", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL, ACCOUNT_DDL);
    const [sam] = await db.insert(schema.users).values({ email: "sam@example.com", displayName: "Sam" }).returning();
    const [quiet] = await db.insert(schema.users).values({ email: "quiet@example.com" }).returning();
    const { editToken, row } = await seedList(db, { folders: [folder], items: [item("i1", "Tent")] });
    const clearThrottle = () => db.update(lists).set({ lastSnapshotAt: new Date(0) }).where(eq(lists.id, row.id));
    let asked = 0;
    const as = (id: number | null) => ({ editor: async () => (asked++, id) });

    await applyOpsByEditToken(editToken, [{ t: "addItem", item: item("i2", "Stakes") }], db, as(sam!.id));
    // inside the window: no point is taken, so nobody is asked
    await applyOpsByEditToken(editToken, [{ t: "addItem", item: item("i3", "Pot") }], db, as(quiet!.id));
    expect(asked).toBe(1);
    await clearThrottle();
    await applyOpsByEditToken(editToken, [{ t: "addItem", item: item("i4", "Cup") }], db, as(quiet!.id));
    await clearThrottle();
    await applyOpsByEditToken(editToken, [{ t: "addItem", item: item("i5", "Lid") }], db, as(null));

    const read = async (viewer: number | null) =>
      (await listSnapshotsByEditToken(editToken, db, viewer))!.map((s) => [s.reason, s.by]);
    expect(await read(sam!.id)).toEqual([
      ["Added Lid", null],
      ["Added Cup", null], // an account with no name stays unnamed to others
      ["Added Stakes", { kind: "you" }],
    ]);
    expect(await read(quiet!.id)).toEqual([
      ["Added Lid", null],
      ["Added Cup", { kind: "you" }],
      ["Added Stakes", { kind: "named", name: "Sam" }],
    ]);
    expect(await read(null)).toEqual([
      ["Added Lid", null],
      ["Added Cup", null],
      ["Added Stakes", { kind: "named", name: "Sam" }],
    ]);
  });

  it("restores a snapshot and snapshots the current state first (undoable)", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { editToken } = await seedList(db, { folders: [folder], items: [item("i1", "Tent"), item("i2", "Quilt")] });
    // "wreck" the list — the mutate snapshots the 2-item original first
    await applyOpsByEditToken(editToken, [{ t: "removeItem", id: "i2" }], db);
    const before = await listSnapshotsByEditToken(editToken, db);
    expect(before).toHaveLength(1);
    expect(before![0]!.itemCount).toBe(2);
    const restored = await restoreSnapshotByEditToken(editToken, before![0]!.id, db);
    expect(restored!.items.map((i) => i.id).sort()).toEqual(["i1", "i2"]);
    // restore captured the current (wrecked) state first → "before restore" exists
    const after = await listSnapshotsByEditToken(editToken, db);
    expect(after!.length).toBeGreaterThanOrEqual(2);
    expect(after!.some((s) => s.reason === "before restore")).toBe(true);
  });

  // What the editor's Restore dialog promises: the list as it was before a restore is
  // a point of its own, and restoring that one undoes the restore.
  it("undoes a restore by restoring the point it left", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { editToken } = await seedList(db, { folders: [folder], items: [item("i1", "Tent"), item("i2", "Quilt")] });
    await applyOpsByEditToken(editToken, [{ t: "removeItem", id: "i2" }], db);
    const [original] = (await listSnapshotsByEditToken(editToken, db))!;
    await restoreSnapshotByEditToken(editToken, original!.id, db);
    const [left] = (await listSnapshotsByEditToken(editToken, db))!;
    expect(left!.reason).toBe("before restore");
    const undone = await restoreSnapshotByEditToken(editToken, left!.id, db);
    expect(undone!.items.map((i) => i.id)).toEqual(["i1"]);
  });

  it("reconstructs old points across a reverse-delta chain (storage = 1 base + N diffs)", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { editToken, row } = await seedList(db, { folders: [folder], items: [item("i1", "Tent"), item("i2", "Quilt")] });
    // force a snapshot per edit by clearing the throttle each time
    const clearThrottle = () => db.update(lists).set({ lastSnapshotAt: new Date(0) }).where(eq(lists.id, row.id));
    await applyOpsByEditToken(editToken, [{ t: "addItem", item: item("i3", "Stove") }], db); // captures state0 [i1,i2]
    await clearThrottle();
    await applyOpsByEditToken(editToken, [{ t: "removeItem", id: "i1" }], db); // captures state1 [i1,i2,i3]
    await clearThrottle();
    await applyOpsByEditToken(editToken, [{ t: "updateItem", id: "i2", patch: { name: "Quilt v2" } }], db); // captures state2 [i2,i3]

    const snaps = await listSnapshotsByEditToken(editToken, db); // newest→oldest
    expect(snaps).toHaveLength(3);
    // exactly one full base; the rest are deltas (the storage win)
    const kinds = await db.select({ kind: schema.listSnapshots.kind }).from(schema.listSnapshots).where(eq(schema.listSnapshots.listId, row.id));
    expect(kinds.filter((k) => k.kind === "base")).toHaveLength(1);

    // oldest snapshot reconstructs to the ORIGINAL pre-edit state [i1, i2]
    const oldest = await restoreSnapshotByEditToken(editToken, snaps![snaps!.length - 1]!.id, db);
    expect(oldest!.items.map((i) => i.id).sort()).toEqual(["i1", "i2"]);
    expect(oldest!.items.find((i) => i.id === "i2")!.name).toBe("Quilt");
    // the middle snapshot reconstructs to [i1, i2, i3]
    const mid = await restoreSnapshotByEditToken(editToken, snaps![1]!.id, db);
    expect(mid!.items.map((i) => i.id).sort()).toEqual(["i1", "i2", "i3"]);
  });

  it("re-applies the reducer's referential invariants on restore (normalizeListData)", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    // corrupted data as a raw create POST could have stored it: dangling refs,
    // deep nesting, a child/parent folder mismatch, and a duplicate id
    const bad: ListData = {
      folders: [folder],
      items: [
        item("p1", "Parent"),
        { ...item("c1", "Child"), parentId: "p1", folderId: "ghost" }, // folder differs from parent's
        { ...item("d1", "Dangler"), folderId: "ghost" }, // folder doesn't exist
        { ...item("o1", "Orphan"), parentId: "nope" }, // parent doesn't exist
        { ...item("g1", "Grand"), parentId: "c1" }, // nested under a nested item
        item("dup", "One"),
        { ...item("dup", "Two"), unitWeightMg: 9 }, // duplicate id
      ],
    };
    const { editToken } = await seedList(db, bad);
    // the mutate captures the corrupted pre-edit state; restoring it must heal
    await applyOpsByEditToken(editToken, [{ t: "updateItem", id: "p1", patch: { name: "P" } }], db);
    const snaps = await listSnapshotsByEditToken(editToken, db);
    const restored = await restoreSnapshotByEditToken(editToken, snaps![0]!.id, db);
    const by = new Map(restored!.items.map((i) => [i.id, i]));
    expect(by.get("d1")!.folderId).toBeNull(); // dangling folderId → ungrouped
    expect(by.get("o1")!.parentId).toBeNull(); // dangling parentId → top-level
    expect(by.get("c1")!.folderId).toBe("f1"); // child rides in its parent's folder
    expect(by.get("g1")!.parentId).toBeNull(); // one nesting level only
    expect(restored!.items.filter((i) => i.id === "dup")).toHaveLength(1);
    expect(by.get("dup")!.name).toBe("One"); // first occurrence wins
  });

  it("re-applies every trail and date metadata normalizer on restore", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { editToken } = await seedList(
      db,
      {
        folders: [folder],
        items: [item("i1", "Tent")],
        waypoints: [{ id: "camp-1", kind: "camp", alongM: 1_200, label: "Cairn Basin" }],
      },
      "Orig",
      {
        trailDistanceM: 0,
        trailDistanceUnit: "km",
        trailProfile: "100.4,200.6",
        trailAscentM: 30_001,
        trailDescentM: -1,
        routeGeometry: "not a polyline",
        startDate: " 2026-02-28 ",
        endDate: "2026-02-30",
      },
    );
    // Capture the raw legacy values, then restore them through the public path.
    await applyOpsByEditToken(editToken, [{ t: "updateItem", id: "i1", patch: { qty: 2 } }], db);
    const snaps = await listSnapshotsByEditToken(editToken, db);
    const restored = await restoreSnapshotByEditToken(editToken, snaps![0]!.id, db);

    expect(restored).toMatchObject({
      trailDistanceUnit: "km",
      trailProfile: "100,201",
      startDate: "2026-02-28",
    });
    expect(restored!.trailDistanceM).toBeUndefined();
    expect(restored!.trailAscentM).toBeUndefined();
    expect(restored!.trailDescentM).toBeUndefined();
    expect(restored!.routeGeometry).toBeUndefined();
    expect(restored!.waypoints).toEqual([]);
    expect(restored!.endDate).toBeUndefined();
  });

  // A list's title can be blank: the editor shows its ghosted placeholder. Going back to
  // a point taken while it was blank handed back the literal words "Untitled list",
  // which is the name a brand-new list starts with and not one this list ever had.
  it("keeps a blank title through a restore", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { editToken } = await seedList(db, { folders: [folder], items: [item("i1", "Tent")] }, "");
    await applyOpsByEditToken(editToken, [{ t: "setMeta", patch: { title: "Named since" } }], db);
    const snaps = await listSnapshotsByEditToken(editToken, db);
    const restored = await restoreSnapshotByEditToken(editToken, snaps![0]!.id, db);
    expect(restored!.title).toBe("");
  });

  // The stored route is this codec's own writing of the line. A snapshot holding the same
  // line written another way is put back canonical, with the pins placed along it.
  it("keeps the pins of a snapshot whose route reads, however it is spelled", async () => {
    const route = encodePolyline([
      { lat: 45.33, lon: -121.71 },
      { lat: 45.36, lon: -121.68 },
      { lat: 45.4, lon: -121.6 },
    ]);
    // the same points with the last value written one chunk longer than it needs
    const respelled = `${route.slice(0, -1)}${String.fromCharCode(route.charCodeAt(route.length - 1) + 0x20)}?`;
    expect(respelled).not.toBe(route);
    const waypoints: Waypoint[] = [
      { id: "wp-start", kind: "trailhead", alongM: 0 },
      { id: "camp-1", kind: "camp", alongM: 1_200, label: "Cairn Basin" },
    ];
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { editToken } = await seedList(db, { folders: [folder], items: [item("i1", "Tent")], waypoints }, "Orig", { routeGeometry: respelled });
    await applyOpsByEditToken(editToken, [{ t: "updateItem", id: "i1", patch: { qty: 2 } }], db);
    const snaps = await listSnapshotsByEditToken(editToken, db);
    const restored = await restoreSnapshotByEditToken(editToken, snaps![0]!.id, db);
    expect(restored!.routeGeometry).toBe(route);
    expect(restored!.waypoints).toEqual(waypoints);
  });

  it("keeps the pins of a snapshot that never had a route", async () => {
    // a pin is a distance along the route, so a route that goes takes them with it
    // (above), but a list can carry pins with no route at all (addWaypoint asks for
    // none), and those never pointed at one; restoring them is restoring the list
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { editToken } = await seedList(db, {
      folders: [folder],
      items: [item("i1", "Tent")],
      waypoints: [{ id: "camp-1", kind: "camp", alongM: 1_200, label: "Cairn Basin" }],
    });
    await applyOpsByEditToken(editToken, [{ t: "updateItem", id: "i1", patch: { qty: 2 } }], db);
    const snaps = await listSnapshotsByEditToken(editToken, db);
    const restored = await restoreSnapshotByEditToken(editToken, snaps![0]!.id, db);
    expect(restored!.items[0]!.qty).toBe(1);
    expect(restored!.waypoints).toEqual([{ id: "camp-1", kind: "camp", alongM: 1_200, label: "Cairn Basin" }]);
  });

  it("won't restore a snapshot that belongs to another list", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const a = await seedList(db, { folders: [], items: [item("x", "A")] });
    const b = await seedList(db, { folders: [], items: [item("y", "B")] });
    await applyOpsByEditToken(a.editToken, [{ t: "updateItem", id: "x", patch: { qty: 2 } }], db);
    const aSnaps = await listSnapshotsByEditToken(a.editToken, db);
    expect(await restoreSnapshotByEditToken(b.editToken, aSnaps![0]!.id, db)).toBeNull();
  });

  it("returns null for an unknown edit token", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    expect(await listSnapshotsByEditToken("nope", db)).toBeNull();
    expect(await restoreSnapshotByEditToken("nope", 1, db)).toBeNull();
  });
});
