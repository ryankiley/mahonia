import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { lists } from "../server/db/schema";
import { LISTS_DDL } from "../server/utils/db";
import { reapAbandonedLists } from "../server/utils/listRepo";
import { sha256Hex } from "../server/utils/tokens";
import type { ListData } from "../shared/types";

// Repo against a fresh in-memory PGlite (mirrors discovery.test.ts).
async function freshDb() {
  const db = drizzle(new PGlite(), { schema });
  for (const stmt of LISTS_DDL) await db.execute(sql.raw(stmt));
  return db;
}

const DAY = 86_400_000;
const emptyData: ListData = { folders: [], items: [] };
const oneItem: ListData = {
  folders: [],
  items: [{ id: "i1", folderId: null, name: "Tent", unitWeightMg: 500_000, qty: 1, classification: null, sortOrder: 0 }],
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

describe("reapAbandonedLists — soft-deletes only abandoned empty lists", () => {
  it("reaps a stale, empty, never-published list", async () => {
    const db = await freshDb();
    const row = await seed(db, { updatedAt: stale() });
    const { reaped } = await reapAbandonedLists(db);
    expect(reaped).toBe(1);
    const after = (await db.select().from(lists).where(sql`id = ${row.id}`))[0]!;
    expect(after.deletedAt).toBeInstanceOf(Date); // soft-deleted, not hard-deleted
  });

  it("leaves recently-touched empty lists alone (within the window)", async () => {
    const db = await freshDb();
    await seed(db, { updatedAt: new Date(Date.now() - 5 * DAY) });
    const { reaped } = await reapAbandonedLists(db);
    expect(reaped).toBe(0);
  });

  it("never reaps a list that has items", async () => {
    const db = await freshDb();
    await seed(db, { updatedAt: stale(), itemCount: 1, data: oneItem });
    const { reaped } = await reapAbandonedLists(db);
    expect(reaped).toBe(0);
  });

  it("guards against a drifted item_count rollup (empty count, non-empty data)", async () => {
    const db = await freshDb();
    // item_count says 0 but the JSONB actually holds an item → must NOT be reaped
    await seed(db, { updatedAt: stale(), itemCount: 0, data: oneItem });
    const { reaped } = await reapAbandonedLists(db);
    expect(reaped).toBe(0);
  });

  it("never reaps a public list, even if empty + stale", async () => {
    const db = await freshDb();
    await seed(db, { updatedAt: stale(), isPublic: true });
    const { reaped } = await reapAbandonedLists(db);
    expect(reaped).toBe(0);
  });

  it("never reaps a once-published list (published_at set), even if unpublished + empty", async () => {
    const db = await freshDb();
    await seed(db, { updatedAt: stale(), isPublic: false, publishedAt: stale() });
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
    const doomed1 = await seed(db, { updatedAt: stale() });
    const doomed2 = await seed(db, { updatedAt: stale() });
    const keepFresh = await seed(db, { updatedAt: new Date() });
    const keepItems = await seed(db, { updatedAt: stale(), itemCount: 1, data: oneItem });
    const keepPublic = await seed(db, { updatedAt: stale(), isPublic: true });

    const { reaped } = await reapAbandonedLists(db);
    expect(reaped).toBe(2);
    const live = await liveIds(db);
    expect(live.sort()).toEqual([keepFresh.id, keepItems.id, keepPublic.id].sort());
    expect(live).not.toContain(doomed1.id);
    expect(live).not.toContain(doomed2.id);
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
