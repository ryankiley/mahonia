// Where this device keeps its copy of an account's My Gear, and how it's dropped.
//
// The copy is what /gear and the list's My Gear pane show when the server can't be
// asked; reading and writing it live with the load, in useVaultList (readGearCopy,
// writeGearCopy), off every page's first load. Only this half is here, because
// useSession's forgetAccountMemos runs on every page and needs nothing but the key.
//
// Keyed per account (ownedKey), never one shared key, and NOT the service worker's
// cache: a cache keyed by URL would hand account A's gear to account B on a shared
// browser offline, where nothing can check who is asking.

import { forget } from "./remember";
import { ownedKey, sessionCacheOwner } from "./sessionOwner";

/** This account's copy's key, or null with no owner marker to key it by. */
export const gearCopyKey = (owner: string | null): string | null => ownedKey("gear.vault.copy.v1", owner);

/** Part of forgetAccountMemos, run on every way out of an account. */
export function forgetGearCopy(owner = sessionCacheOwner()): void {
  if (!import.meta.client) return;
  const key = gearCopyKey(owner);
  if (key) forget(key);
}
