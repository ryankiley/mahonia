// Where this device keeps its copy of an account's My Gear.
//
// The copy is what /gear and the list's My Gear pane show when the server can't be
// asked; reading and writing it live with the load, in useVaultList (readGearCopy,
// writeGearCopy), off every page's first load. It is dropped with the account's
// other memos, by forgetOwned (sessionOwner.ts), which knows it by OWNED.gearCopy.
//
// Keyed per account (ownedKey), never one shared key, and NOT the service worker's
// cache: a cache keyed by URL would hand account A's gear to account B on a shared
// browser offline, where nothing can check who is asking.

import { OWNED, ownedKey } from "./sessionOwner";

/** This account's copy's key, or null with no owner marker to key it by. */
export const gearCopyKey = (owner: string | null): string | null => ownedKey(OWNED.gearCopy, owner);
