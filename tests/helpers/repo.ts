// Repo entry points keyed on the RAW edit token, for suites that hold one.
//
// The server never does: the endpoint gate (editAuth) resolves either capability
// — bearer token or session + claimed share code — to the hash, and every repo
// function is hash-first from there. A test that made a list holds the token
// itself, so these hash it at the call site rather than each suite spelling
// `sha256Hex(editToken)` a dozen times. Thin on purpose: nothing here may add
// behaviour the production path doesn't have.

import type { TestDb } from "./db";
import type { ListRow } from "../../server/db/schema";
import type { Op } from "../../shared/ops";
import type { ListSnapshot } from "../../shared/types";
import { sha256Hex } from "../../server/utils/tokens";
import {
  applyOpsByEditHash,
  findByEditHash,
  listSnapshotsByEditHash,
  restoreSnapshotByEditHash,
  softDeleteByEditHash,
  type SnapshotMeta,
} from "../../server/utils/listRepo";
import { getPublishStateByEditHash } from "../../server/utils/discoveryRepo";
import { existingCredentialIds } from "../../server/utils/credentialRepo";
import type { PublishState } from "../../shared/discovery";

export function findByEditToken(editToken: string, db?: TestDb): Promise<ListRow | null> {
  return findByEditHash(sha256Hex(editToken), db);
}

export function listSnapshotsByEditToken(
  editToken: string,
  db?: TestDb,
): Promise<SnapshotMeta[] | null> {
  return listSnapshotsByEditHash(sha256Hex(editToken), db);
}

export function restoreSnapshotByEditToken(
  editToken: string,
  snapshotId: number,
  db?: TestDb,
): Promise<ListSnapshot | null> {
  return restoreSnapshotByEditHash(sha256Hex(editToken), snapshotId, db);
}

export function softDeleteByEditToken(editToken: string, db?: TestDb): Promise<boolean> {
  return softDeleteByEditHash(sha256Hex(editToken), db);
}

export function applyOpsByEditToken(
  editToken: string,
  ops: Op[],
  db?: TestDb,
): Promise<ListSnapshot | null> {
  return applyOpsByEditHash(sha256Hex(editToken), ops, db);
}

export function getPublishState(editToken: string, db?: TestDb): Promise<PublishState | null> {
  return getPublishStateByEditHash(sha256Hex(editToken), db);
}

/** How many passkeys an account holds — the suites' way of watching a
 *  registration or a removal land. */
export async function countPasskeys(db: TestDb, userId: number): Promise<number> {
  return (await existingCredentialIds(db, userId)).length;
}
