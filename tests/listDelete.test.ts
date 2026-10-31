import { describe, expect, it } from "vitest";
import { lists } from "../server/db/schema";
import { LISTS_DDL, SNAPSHOTS_DDL } from "../server/utils/db";
import { findByEditHash, softDeleteByEditHash } from "../server/utils/listRepo";
import { byToken, createTestDb, makeList } from "./helpers/db";

const findByEditToken = byToken(findByEditHash);
const softDeleteByEditToken = byToken(softDeleteByEditHash);

// Repo against a fresh in-memory PGlite (mirrors reapLists.test / discovery.test).

describe("softDeleteByEditHash — owner-initiated delete", () => {
  it("soft-deletes the token's list and drops it from the capability lookup", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { editToken } = await makeList(db);

    expect(await findByEditToken(editToken, db)).not.toBeNull(); // live before

    expect(await softDeleteByEditToken(editToken, db)).toBe(true);

    // gone from the live lookup (findByEditHash filters deletedAt)…
    expect(await findByEditToken(editToken, db)).toBeNull();
    // …but the row still exists with deletedAt set (purge reclaims it later)
    const rows = await db.select().from(lists);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deletedAt).toBeInstanceOf(Date);
  });

  it("leaves other lists untouched", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const keep = await makeList(db);
    const drop = await makeList(db);

    await softDeleteByEditToken(drop.editToken, db);

    expect(await findByEditToken(keep.editToken, db)).not.toBeNull();
    expect(await findByEditToken(drop.editToken, db)).toBeNull();
  });

  it("returns false for an unknown or already-deleted token (→ 404, no oracle)", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { editToken } = await makeList(db);

    expect(await softDeleteByEditToken("never-existed", db)).toBe(false);

    expect(await softDeleteByEditToken(editToken, db)).toBe(true);
    expect(await softDeleteByEditToken(editToken, db)).toBe(false); // second time: already gone
  });
});
