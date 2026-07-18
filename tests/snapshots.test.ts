import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { lists } from "../server/db/schema";
import { LISTS_DDL, SNAPSHOTS_DDL, _resetSnapshotEnsured } from "../server/utils/db";
import { sha256Hex } from "../server/utils/tokens";
import {
  applyOpsByEditToken,
  listSnapshotsByEditToken,
  restoreSnapshotByEditToken,
} from "../server/utils/listRepo";
import type { Item, ListData } from "../shared/types";

// Fresh in-memory PGlite with the list + snapshot tables (mirrors discovery.test).
async function freshDb() {
  const db = drizzle(new PGlite(), { schema });
  for (const stmt of [...LISTS_DDL, ...SNAPSHOTS_DDL]) await db.execute(sql.raw(stmt));
  return db;
}

let seq = 0;
async function seedList(db: Awaited<ReturnType<typeof freshDb>>, data: ListData, title = "Orig") {
  seq++;
  const editToken = `snap-tok-${seq}`;
  const [row] = await db
    .insert(lists)
    .values({
      publicSlug: `snap-${seq}-aaa${seq}`,
      editTokenHash: sha256Hex(editToken),
      shareCode: `SNAPCODE${seq}000`.slice(0, 12),
      title,
      data,
      itemCount: data.items.length,
      version: 1,
    })
    .returning();
  return { row: row!, editToken };
}

const folder = { id: "f1", name: "Shelter", colorKey: "shelter", defaultClassification: "base" as const, sortOrder: 0 };
const item = (id: string, name: string): Item => ({
  id,
  folderId: "f1",
  name,
  unitWeightMg: 1000,
  weightOverridden: false,
  qty: 1,
  classification: null,
  sortOrder: 0,
  packed: false,
});

describe("snapshots — vandalism recovery", () => {
  it("auto-snapshots the pre-edit state, throttled to one per window", async () => {
    const db = await freshDb();
    const { editToken } = await seedList(db, { folders: [folder], items: [item("i1", "Tent")] });
    await applyOpsByEditToken(editToken, [{ t: "updateItem", id: "i1", patch: { name: "Tent v2" } }], db);
    let snaps = await listSnapshotsByEditToken(editToken, db);
    expect(snaps).toHaveLength(1);
    expect(snaps![0]!.reason).toBe("edit");
    // a second mutate within the throttle window adds no new snapshot
    await applyOpsByEditToken(editToken, [{ t: "updateItem", id: "i1", patch: { name: "Tent v3" } }], db);
    snaps = await listSnapshotsByEditToken(editToken, db);
    expect(snaps).toHaveLength(1);
  });

  it("restores a snapshot and snapshots the current state first (undoable)", async () => {
    const db = await freshDb();
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

  it("reconstructs old points across a reverse-delta chain (storage = 1 base + N diffs)", async () => {
    const db = await freshDb();
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
    const db = await freshDb();
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

  it("won't restore a snapshot that belongs to another list", async () => {
    const db = await freshDb();
    const a = await seedList(db, { folders: [], items: [item("x", "A")] });
    const b = await seedList(db, { folders: [], items: [item("y", "B")] });
    await applyOpsByEditToken(a.editToken, [{ t: "updateItem", id: "x", patch: { qty: 2 } }], db);
    const aSnaps = await listSnapshotsByEditToken(a.editToken, db);
    expect(await restoreSnapshotByEditToken(b.editToken, aSnaps![0]!.id, db)).toBeNull();
  });

  it("returns null for an unknown edit token", async () => {
    const db = await freshDb();
    expect(await listSnapshotsByEditToken("nope", db)).toBeNull();
    expect(await restoreSnapshotByEditToken("nope", 1, db)).toBeNull();
  });

  it("bootstraps the snapshots table on first use (Neon request-path)", async () => {
    // build WITHOUT the snapshots DDL — the repo must create it lazily via ensureSnapshotSchema
    const db = drizzle(new PGlite(), { schema });
    for (const stmt of LISTS_DDL) await db.execute(sql.raw(stmt));
    _resetSnapshotEnsured();
    const { editToken } = await seedList(db, { folders: [], items: [item("i1", "X")] });
    expect(await listSnapshotsByEditToken(editToken, db)).toEqual([]);
  });
});
