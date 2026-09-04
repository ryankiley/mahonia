import { describe, expect, it } from "vitest";
import { lists } from "../server/db/schema";
import { LISTS_DDL, SNAPSHOTS_DDL, ensureSnapshotSchema } from "../server/utils/db";
import { findByEditToken, softDeleteByEditToken } from "./helpers/repo";
import { sha256Hex } from "../server/utils/tokens";
import { createTestDb } from "./helpers/db";

// Repo against a fresh in-memory PGlite (mirrors reapLists.test / discovery.test).
async function freshDb() {
  const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
  ensureSnapshotSchema.reset();
  return db;
}

let seq = 0;
async function seed(db: Awaited<ReturnType<typeof freshDb>>, token: string) {
  seq++;
  await db.insert(lists).values({
    publicSlug: `slug-${seq}`,
    editTokenHash: sha256Hex(token),
    shareCode: `SHARECODE${seq}00`,
    title: `List ${seq}`,
    data: { folders: [], items: [] },
    itemCount: 0,
  });
}

describe("softDeleteByEditToken — owner-initiated delete", () => {
  it("soft-deletes the token's list and drops it from the capability lookup", async () => {
    const db = await freshDb();
    await seed(db, "tok-a");

    expect(await findByEditToken("tok-a", db)).not.toBeNull(); // live before

    expect(await softDeleteByEditToken("tok-a", db)).toBe(true);

    // gone from the live lookup (findByEditToken filters deletedAt)…
    expect(await findByEditToken("tok-a", db)).toBeNull();
    // …but the row still exists with deletedAt set (purge reclaims it later)
    const rows = await db.select().from(lists);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deletedAt).toBeInstanceOf(Date);
  });

  it("leaves other lists untouched", async () => {
    const db = await freshDb();
    await seed(db, "tok-keep");
    await seed(db, "tok-drop");

    await softDeleteByEditToken("tok-drop", db);

    expect(await findByEditToken("tok-keep", db)).not.toBeNull();
    expect(await findByEditToken("tok-drop", db)).toBeNull();
  });

  it("returns false for an unknown or already-deleted token (→ 404, no oracle)", async () => {
    const db = await freshDb();
    await seed(db, "tok-x");

    expect(await softDeleteByEditToken("never-existed", db)).toBe(false);

    expect(await softDeleteByEditToken("tok-x", db)).toBe(true);
    expect(await softDeleteByEditToken("tok-x", db)).toBe(false); // second time: already gone
  });
});
