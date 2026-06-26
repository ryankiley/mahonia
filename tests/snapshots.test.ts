import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
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
