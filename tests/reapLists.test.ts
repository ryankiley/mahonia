import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { lists, listSnapshots } from "../server/db/schema";
import { LISTS_DDL, SNAPSHOTS_DDL, _resetSnapshotEnsured } from "../server/utils/db";
import { purgeDeletedLists, reapAbandonedLists } from "../server/utils/listRepo";
import { sha256Hex } from "../server/utils/tokens";
import type { ListData } from "../shared/types";

// Repo against a fresh in-memory PGlite (mirrors discovery.test.ts). Creates the
// snapshots table too (the purge cascades into it), and resets the memoized
// ensure so purgeDeletedLists's ensureSnapshotSchema runs against THIS db.
async function freshDb() {
  const db = drizzle(new PGlite(), { schema });
  for (const stmt of [...LISTS_DDL, ...SNAPSHOTS_DDL]) await db.execute(sql.raw(stmt));
  _resetSnapshotEnsured();
  return db;
}

const DAY = 86_400_000;
const emptyData: ListData = { folders: [], items: [] };
const oneItem: ListData = {
  folders: [],
  items: [{ id: "i1", folderId: null, name: "Tent", unitWeightMg: 500_000, qty: 1, classification: null, sortOrder: 0 }],
};
const twoItems: ListData = {
  folders: [],
  items: [
    { id: "i1", folderId: null, name: "Tent", unitWeightMg: 500_000, qty: 1, classification: null, sortOrder: 0 },
    { id: "i2", folderId: null, name: "Quilt", unitWeightMg: 400_000, qty: 1, classification: null, sortOrder: 1 },
  ],
};

let seq = 0;
async function seed(
  db: Awaited<ReturnType<typeof freshDb>>,
  o: Partial<typeof lists.$inferInsert> = {},
) {
  seq++;
  const [row] = await db
    .insert(lists)
    .values({
      publicSlug: o.publicSlug ?? `list-${seq}-aaa${seq}`,
      editTokenHash: sha256Hex(`tok-${seq}`),
      shareCode: o.shareCode ?? `SHARECODE${seq}00`,
      title: o.title ?? `List ${seq}`,
      data: o.data ?? emptyData,
      itemCount: o.itemCount ?? 0,
      isPublic: o.isPublic ?? false,
      status: o.status ?? "active",
      publishedAt: o.publishedAt ?? null,
      // default rows look "just touched" so only tests that WANT staleness set it
      updatedAt: o.updatedAt ?? new Date(),
      deletedAt: o.deletedAt ?? null,
    })
    .returning();
  return row!;
}

const stale = () => new Date(Date.now() - 40 * DAY); // past the 30-day default

const liveIds = async (db: Awaited<ReturnType<typeof freshDb>>) =>
  (await db.select({ id: lists.id, deletedAt: lists.deletedAt }).from(lists))
    .filter((r) => r.deletedAt == null)
    .map((r) => r.id);

describe("reapAbandonedLists — soft-deletes near-empty abandoned lists", () => {
  it("reaps a stale empty (0-item) list", async () => {
    const db = await freshDb();
    const row = await seed(db, { updatedAt: stale() });
    const { reaped } = await reapAbandonedLists(db);
    expect(reaped).toBe(1);
    const after = (await db.select().from(lists).where(sql`id = ${row.id}`))[0]!;
    expect(after.deletedAt).toBeInstanceOf(Date); // soft-deleted, not hard-deleted
  });

  it("reaps a stale one-item list", async () => {
    const db = await freshDb();
    await seed(db, { updatedAt: stale(), itemCount: 1, data: oneItem });
    const { reaped } = await reapAbandonedLists(db);
    expect(reaped).toBe(1);
  });

  it("NEVER reaps a real list (2+ items), however stale — the Loowit rule", async () => {
    const db = await freshDb();
    // a finished list untouched for a year must survive: staleness is not grounds
    await seed(db, { updatedAt: new Date(Date.now() - 365 * DAY), itemCount: 2, data: twoItems });
    const { reaped } = await reapAbandonedLists(db);
    expect(reaped).toBe(0);
  });

  it("leaves a near-empty list touched within the window (staleness is only a debounce)", async () => {
    const db = await freshDb();
    await seed(db, { updatedAt: new Date(Date.now() - 5 * DAY), itemCount: 1, data: oneItem });
    const { reaped } = await reapAbandonedLists(db);
    expect(reaped).toBe(0);
  });

  it("publish status is not a factor — reaps a public/once-published near-empty list", async () => {
    const db = await freshDb();
    await seed(db, { updatedAt: stale(), itemCount: 1, data: oneItem, isPublic: true, publishedAt: stale() });
    const { reaped } = await reapAbandonedLists(db);
    expect(reaped).toBe(1);
  });

  it("guards against a drifted item_count (rollup says 0 but data holds 2 items)", async () => {
    const db = await freshDb();
    // the actual JSONB item array (2) wins over a stale count → real list, survives
    await seed(db, { updatedAt: stale(), itemCount: 0, data: twoItems });
    const { reaped } = await reapAbandonedLists(db);
    expect(reaped).toBe(0);
  });

  it("ignores non-active (hidden/removed) and already-deleted rows", async () => {
    const db = await freshDb();
    await seed(db, { updatedAt: stale(), status: "hidden" });
    await seed(db, { updatedAt: stale(), status: "removed" });
    await seed(db, { updatedAt: stale(), deletedAt: new Date() });
    const { reaped } = await reapAbandonedLists(db);
    expect(reaped).toBe(0);
  });

  it("reaps only the eligible rows in a mixed table", async () => {
    const db = await freshDb();
    const doomedEmpty = await seed(db, { updatedAt: stale() });
    const doomedOne = await seed(db, { updatedAt: stale(), itemCount: 1, data: oneItem });
    const keepFresh = await seed(db, { updatedAt: new Date() });
    const keepReal = await seed(db, { updatedAt: new Date(Date.now() - 365 * DAY), itemCount: 2, data: twoItems });

    const { reaped } = await reapAbandonedLists(db);
    expect(reaped).toBe(2);
    const live = await liveIds(db);
    expect(live.sort()).toEqual([keepFresh.id, keepReal.id].sort());
    expect(live).not.toContain(doomedEmpty.id);
    expect(live).not.toContain(doomedOne.id);
  });

  it("respects a custom staleDays window", async () => {
    const db = await freshDb();
    await seed(db, { updatedAt: new Date(Date.now() - 10 * DAY) });
    expect((await reapAbandonedLists(db, { staleDays: 30 })).reaped).toBe(0); // 10d < 30d
    expect((await reapAbandonedLists(db, { staleDays: 7 })).reaped).toBe(1); // 10d > 7d
  });

  it("respects the batch limit (backlog drains over runs)", async () => {
    const db = await freshDb();
    for (let i = 0; i < 3; i++) await seed(db, { updatedAt: stale() });
    expect((await reapAbandonedLists(db, { limit: 2 })).reaped).toBe(2);
    expect((await reapAbandonedLists(db, { limit: 2 })).reaped).toBe(1);
    expect((await reapAbandonedLists(db, { limit: 2 })).reaped).toBe(0);
  });
});

const softDeleted = (days: number) => new Date(Date.now() - days * DAY);

const rowCount = async (db: Awaited<ReturnType<typeof freshDb>>) =>
  (await db.select({ id: lists.id }).from(lists)).length;

describe("purgeDeletedLists — hard-deletes rows past the grace window", () => {
  it("purges a list soft-deleted longer than the grace period", async () => {
    const db = await freshDb();
    await seed(db, { deletedAt: softDeleted(100) }); // > 90-day default
    const { purged } = await purgeDeletedLists(db);
    expect(purged).toBe(1);
    expect(await rowCount(db)).toBe(0); // physically gone, not just hidden
  });

  it("keeps a recently soft-deleted list inside the grace window", async () => {
    const db = await freshDb();
    await seed(db, { deletedAt: softDeleted(10) }); // < 90 days → still recoverable
    const { purged } = await purgeDeletedLists(db);
    expect(purged).toBe(0);
    expect(await rowCount(db)).toBe(1);
  });

  it("never touches a live (not soft-deleted) list", async () => {
    const db = await freshDb();
    await seed(db, { deletedAt: null, updatedAt: softDeleted(400) }); // ancient but alive
    const { purged } = await purgeDeletedLists(db);
    expect(purged).toBe(0);
    expect(await rowCount(db)).toBe(1);
  });

  it("cascades: drops the purged list's snapshots too", async () => {
    const db = await freshDb();
    const row = await seed(db, { deletedAt: softDeleted(100) });
    await db.insert(listSnapshots).values({
      listId: row.id,
      kind: "base",
      snapshot: {} as never, // shape irrelevant to the purge
      itemCount: 0,
      version: 1,
    });
    expect((await db.select().from(listSnapshots)).length).toBe(1);
    const { purged } = await purgeDeletedLists(db);
    expect(purged).toBe(1);
    expect((await db.select().from(listSnapshots)).length).toBe(0); // orphan snapshots gone
  });

  it("does not immediately purge a list the reaper just soft-deleted", async () => {
    const db = await freshDb();
    await seed(db, { updatedAt: stale() });
    expect((await reapAbandonedLists(db)).reaped).toBe(1); // deleted_at = now
    expect((await purgeDeletedLists(db)).purged).toBe(0); // inside the grace window
    expect(await rowCount(db)).toBe(1); // soft-deleted, still recoverable
  });

  it("respects a custom graceDays window", async () => {
    const db = await freshDb();
    await seed(db, { deletedAt: softDeleted(20) });
    expect((await purgeDeletedLists(db, { graceDays: 30 })).purged).toBe(0); // 20d < 30d
    expect((await purgeDeletedLists(db, { graceDays: 7 })).purged).toBe(1); // 20d > 7d
  });

  it("respects the batch limit (backlog drains over runs)", async () => {
    const db = await freshDb();
    for (let i = 0; i < 3; i++) await seed(db, { deletedAt: softDeleted(100) });
    expect((await purgeDeletedLists(db, { limit: 2 })).purged).toBe(2);
    expect((await purgeDeletedLists(db, { limit: 2 })).purged).toBe(1);
    expect((await purgeDeletedLists(db, { limit: 2 })).purged).toBe(0);
  });
});
