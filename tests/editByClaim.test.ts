import { beforeEach, describe, expect, it } from "vitest";
import { LISTS_DDL } from "../server/utils/db";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { claimLists, claimedEditHash, listClaimedLists } from "../server/utils/claimRepo";
import {
  applyOpsByEditHash,
  findByEditHash,
  rotateEditHash,
  softDeleteByEditHash,
} from "../server/utils/listRepo";
import { getPublishStateByEditHash, publishListByEditHash } from "../server/utils/discoveryRepo";
import { sha256Hex } from "../server/utils/tokens";
import { createTestDb, makeList as makeListRow, type TestDb } from "./helpers/db";
import { folder, item } from "./helpers/list";

// The session path END TO END at the repo layer: a claim resolves a share code to
// the list's edit hash (claimedEditHash), and every edit-shaped operation accepts
// that hash exactly as it accepts one derived from a bearer token. This is what
// lets a claimed list OPEN AND EDIT on a device that never saw its edit link —
// the half of the account feature the endpoints never wired up before.
//
// The ByEditToken wrappers stay covered by the existing suites (snapshots,
// listDelete, discovery); what's new here is the hash arriving FROM A CLAIM.

// A list with real content, so ops have rows to land on.
const makeList = (db: TestDb, title = "Sierra trip") =>
  makeListRow(db, title, {
    data: {
      folders: [folder({ colorKey: "shelter" })],
      items: [
        item({ id: "i1", name: "Tent", unitWeightMg: 1_000_000 }),
        item({ id: "i2", name: "Stake", unitWeightMg: 10_000, qty: 6, sortOrder: 1 }),
      ],
    },
    itemCount: 2,
    version: 1,
  });

describe("editing a claimed list through the session-resolved hash", () => {
  let db: TestDb;
  const USER = 1;
  beforeEach(async () => {
    db = await createTestDb(LISTS_DDL, ACCOUNT_DDL);
  });

  it("applies ops via the hash a claim resolves — no token on the calling device", async () => {
    const list = await makeList(db);
    await claimLists(db, USER, [list.editToken]);

    const hash = await claimedEditHash(db, USER, list.shareCode);
    expect(hash).toBe(sha256Hex(list.editToken));

    const snap = await applyOpsByEditHash(hash!, [{ t: "setMeta", patch: { title: "Renamed on the phone" } }], db);
    expect(snap?.title).toBe("Renamed on the phone");
    expect(snap?.version).toBe(2);

    // and the claimed listing reads the new state back — what the switcher shows
    const claimed = await listClaimedLists(db, USER);
    expect(claimed[0]?.title).toBe("Renamed on the phone");
  });

  it("keeps the claimer editing across a rotate — the hash is re-read, never cached", async () => {
    const list = await makeList(db);
    await claimLists(db, USER, [list.editToken]);
    const before = await claimedEditHash(db, USER, list.shareCode);

    // the owner rotates (keeping the rotator's claim, per rotateEditHash)
    await rotateEditHash(sha256Hex(list.editToken), USER, db);

    // the OLD hash is dead for everyone…
    expect(await applyOpsByEditHash(before!, [{ t: "setMeta", patch: { title: "x" } }], db)).toBeNull();
    // …but the claim resolves the CURRENT one and edits keep landing
    const after = await claimedEditHash(db, USER, list.shareCode);
    expect(after).not.toBe(before);
    const snap = await applyOpsByEditHash(after!, [{ t: "setMeta", patch: { title: "Still mine" } }], db);
    expect(snap?.title).toBe("Still mine");
  });

  it("deletes via the claim, and the dead list stops resolving for everyone", async () => {
    const list = await makeList(db);
    await claimLists(db, USER, [list.editToken]);
    const hash = await claimedEditHash(db, USER, list.shareCode);

    expect(await softDeleteByEditHash(hash!, db)).toBe(true);
    expect(await findByEditHash(hash!, db)).toBeNull(); // token path dead too
    expect(await claimedEditHash(db, USER, list.shareCode)).toBeNull();
    expect(await listClaimedLists(db, USER)).toHaveLength(0);
  });

  it("publishes via the claim — state reads and writes both take the resolved hash", async () => {
    const list = await makeList(db);
    await claimLists(db, USER, [list.editToken]);
    const hash = await claimedEditHash(db, USER, list.shareCode);

    expect((await getPublishStateByEditHash(hash!, db))?.isPublic).toBe(false);
    const state = await publishListByEditHash(hash!, { isPublic: true }, db);
    expect(state?.isPublic).toBe(true);
  });

  it("an unclaimed code resolves to nothing an edit can use", async () => {
    const list = await makeList(db);
    // no claim made — the session path must not manufacture a capability
    expect(await claimedEditHash(db, USER, list.shareCode)).toBeNull();
  });
});
