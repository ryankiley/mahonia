// My Gear as this device last read it, kept per account: what /gear and the list's
// My Gear pane show when the server can't be asked.
//
// My Gear is a fetch, and offline the fetch is the one thing that can't happen. A
// signed-in visitor even READS as signed out there (/api/auth/me fails first), so the
// page asked them to sign in, and with nothing kept on the device there was no gear
// to show once that was fixed (2026-11-09). The switcher's account rows were the same
// story and got the same answer (useClaimedLists's CLAIMED_ROWS_KEY).
//
// Keyed by the session's owner marker, not one shared key, and NOT the service
// worker's cache: a cache keyed by URL would hand account A's gear to account B on a
// shared browser offline, where nothing can check who is asking. useSession's
// forgetAccountMemos drops it on every way out of an account, and the owner key means
// a copy that somehow outlived that still can't be read by anyone else.
//
// A copy, never a source: every successful read replaces it whole, and nothing is
// ever changed through it (offline, My Gear is read-only).

import type { VaultEntry } from "~~/shared/vault";
import { forget, recallJson, remember } from "./remember";
import { sessionCacheOwner } from "./sessionOwner";

const KEY = "gear.vault.copy.v1";

// localStorage is shared with every other memo on the origin, and a copy is worth
// keeping only while it leaves room for them. A typical piece is a few hundred bytes,
// so this is thousands of pieces; past it the copy is dropped rather than kept stale.
const MAX_CHARS = 1_500_000;

export interface GearCopy {
  items: VaultEntry[];
  /** when it was read from the server, epoch ms */
  savedAt: number;
}

const keyFor = (owner: string | null) => (owner === null ? null : `${KEY}.${owner}`);

const isCopy = (v: unknown): v is GearCopy =>
  typeof v === "object" && v !== null && Array.isArray((v as GearCopy).items) && typeof (v as GearCopy).savedAt === "number";

/** This account's copy, or null: none kept, no owner to key it by, or unreadable. */
export function readGearCopy(owner = sessionCacheOwner()): GearCopy | null {
  const key = keyFor(owner);
  return key ? recallJson(key, isCopy, null) : null;
}

/** Keep the server's latest answer. Too big to keep is the same as none. */
export function writeGearCopy(items: VaultEntry[], owner = sessionCacheOwner(), now = Date.now()): void {
  const key = keyFor(owner);
  if (!key) return;
  const json = JSON.stringify({ items, savedAt: now } satisfies GearCopy);
  if (json.length > MAX_CHARS) forget(key);
  else remember(key, json);
}

/** Part of forgetAccountMemos, run on every way out of an account. */
export function forgetGearCopy(owner = sessionCacheOwner()): void {
  if (!import.meta.client) return;
  const key = keyFor(owner);
  if (key) forget(key);
}
