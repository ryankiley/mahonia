// An edit sent twice lands once (shared/opStamp.ts).
//
// The editor keeps an op on the device until the server answers for it, so an op whose
// answer never arrived (the tab closed, the editor moved to another list) goes again
// on the next open, though it may already have landed. The reducer's ops are absolute,
// so a second landing undid whatever had happened since: a removal removed again what
// a restore had brought back.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { lists } from "../server/db/schema";
import { LISTS_DDL, SNAPSHOTS_DDL } from "../server/utils/db";
import { applyOpsByEditHash, listSnapshotsByEditHash, restoreSnapshotByEditHash } from "../server/utils/listRepo";
import { APPLIED_SESSIONS_KEPT, freshOps, type StampedOp } from "../shared/opStamp";
import type { Op } from "../shared/ops";
import { byToken, createTestDb, makeList, type TestDb } from "./helpers/db";
import { folder as listFolder, item as listItem } from "./helpers/list";

const apply = byToken(applyOpsByEditHash);
const recoveryPoints = byToken(listSnapshotsByEditHash);
const restore = byToken(restoreSnapshotByEditHash);

const folder = listFolder({ name: "Kitchen", colorKey: "shelter" });
const item = listItem({ id: "i1", name: "Stove", folderId: "f1", unitWeightMg: 80_000, weightOverridden: false, packed: false });

const seeded = (db: TestDb) => makeList(db, "Trip", { data: { folders: [folder], items: [item] }, itemCount: 1, version: 1 });
const stamped = (op: Op, from: string, seq: number): StampedOp => ({ ...op, from, seq });
const rename = (name: string): Op => ({ t: "updateItem", id: "i1", patch: { name } });
const row = async (db: TestDb, id: number) => (await db.select().from(lists).where(eq(lists.id, id)))[0]!;

describe("applyOpsByEditHash — an op sent twice", () => {
  it("lands once, and its copy leaves a later edit standing", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { id, editToken } = await seeded(db);
    const first = stamped(rename("Pocket Rocket"), "laptop", 1);

    await apply(editToken, [first], db);
    // someone else renames it afterwards: a collaborator, the phone, an assistant
    await apply(editToken, [rename("Soto Windmaster")], db);
    // the laptop never heard the answer to its batch, and sends it again on its next open
    const echo = await apply(editToken, [first], db);

    expect(echo?.items[0]?.name).toBe("Soto Windmaster");
    // nothing was written for it: the version is the one the collaborator's edit left
    expect((await row(db, id)).version).toBe(3);
  });

  it("does not undo a restore made in between", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { editToken } = await seeded(db);
    const removal = stamped({ t: "removeFolder", id: "f1" }, "laptop", 1);

    await apply(editToken, [removal], db);
    const [before] = (await recoveryPoints(editToken, db))!;
    await restore(editToken, before!.id, db);
    const after = await apply(editToken, [removal], db);

    expect(after?.folders.map((f) => f.name)).toEqual(["Kitchen"]);
    expect(after?.items.map((i) => i.name)).toEqual(["Stove"]);
  });

  it("applies what follows a copy in the same batch", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { editToken } = await seeded(db);
    await apply(editToken, [stamped(rename("Pocket Rocket"), "laptop", 1)], db);
    const echo = await apply(
      editToken,
      [stamped(rename("Pocket Rocket"), "laptop", 1), stamped({ t: "updateItem", id: "i1", patch: { qty: 2 } }, "laptop", 2)],
      db,
    );
    expect(echo?.items[0]).toMatchObject({ name: "Pocket Rocket", qty: 2 });
  });

  // the connector, the iOS app, and an editor cached from before stamps
  it("applies an op without a stamp every time it comes", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { id, editToken } = await seeded(db);
    await apply(editToken, [rename("Pocket Rocket")], db);
    await apply(editToken, [rename("Pocket Rocket")], db);
    expect((await row(db, id)).version).toBe(3);
    expect((await row(db, id)).appliedThrough).toBeNull();
  });

  it("remembers a bounded number of sessions, the most recent", async () => {
    const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
    const { id, editToken } = await seeded(db);
    for (let n = 0; n <= APPLIED_SESSIONS_KEPT; n++) await apply(editToken, [stamped(rename(`v${n}`), `s${n}`, 1)], db);
    const kept = (await row(db, id)).appliedThrough!;
    expect(kept).toHaveLength(APPLIED_SESSIONS_KEPT);
    expect(kept.at(-1)).toEqual([`s${APPLIED_SESSIONS_KEPT}`, 1]);
    expect(kept.some(([from]) => from === "s0")).toBe(false);
  });
});

describe("freshOps", () => {
  const op = rename("x");
  it("skips an op at or below what its session reached, and moves the session to the end", () => {
    const { fresh, applied } = freshOps(
      [stamped(op, "a", 3), stamped(op, "a", 4), stamped(op, "b", 1)],
      [["a", 3], ["c", 9]],
    );
    expect(fresh.map((o) => [o.from, o.seq])).toEqual([["a", 4], ["b", 1]]);
    expect(applied).toEqual([["c", 9], ["a", 4], ["b", 1]]);
  });

  it("treats a stamp it can't read as no stamp", () => {
    const odd = [{ ...op, from: "has space", seq: 1 }, { ...op, from: "a", seq: 0 }, { ...op, from: "a", seq: 1.5 }];
    const { fresh, applied } = freshOps(odd, null);
    expect(fresh).toHaveLength(3);
    expect(applied).toBeNull();
  });
});
