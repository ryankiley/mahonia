// On-device durability for the editor. The editor queues edits as Ops and flushes
// them to the server; this module backs that queue with the browser's IndexedDB so
// an unsaved draft or an un-acked op survives a reload, a crash, or a dropped
// connection. Pure + framework-agnostic (so it's unit-testable); the IndexedDB
// plumbing lives in app/composables/useLocalListStore.ts.
//
// Imports only a TYPE from the reducer, and that is load-bearing: the claimed-list
// composable reads a key helper from here, the session plugin pulls that composable
// in, and so this file is on every page's boot path. A value import of applyOps
// (which rebaseOnto used to make here) carried the whole reducer and everything it
// folds in — the trail, polyline and profile arithmetic — onto the About page and
// the share views, none of which edit anything.

import type { Op } from "./ops";
import type { ListSnapshot } from "./types";

/** A list persisted to this browser's IndexedDB so its edits survive a reload. */
export interface LocalListRecord {
  snapshot: ListSnapshot;
  pending: Op[]; // ops applied locally but not yet acknowledged by the server
  updatedAt: number;
}

/**
 * A list "has content" once any ITEM carries a name or a weight — nothing else counts.
 * The editor doesn't persist a draft (or count it as a keepable list) until then, so
 * opening the site and bouncing leaves no row behind; the sync line reads the same
 * gate to say "Saved on device" only when there's something saved.
 *
 * Deliberately NOT counted: a title, and a trail link. Both are things you can set
 * while circling a list you never actually make, and a pack list with no gear in it
 * isn't a pack list. A link-only draft still shows its site mark — ListHead asks
 * /api/trail-favicon directly, so nothing about the icon depends on having a row.
 */
export function hasRealContent(s: Pick<ListSnapshot, "items">): boolean {
  return s.items.some((i) => i.name.trim() !== "" || i.unitWeightMg > 0);
}

/** Fixed key for the single in-progress, not-yet-saved draft (one at a time). */
export const DRAFT_KEY = "__draft__";

/** IndexedDB key for a list: its edit token, or the draft slot before first save. */
export const localKey = (editToken: string): string => editToken || DRAFT_KEY;

/** IndexedDB key for a CLAIMED open — a list reached by share code + session, with
 *  no edit token on this device. Prefixed so it can never collide with a token
 *  (tokens are base64url and never contain ":"). A device that later opens the
 *  same list's edit link gets a separate record under the token, which is fine:
 *  the claimed record simply goes quiet, and re-opening by claim drains any queue
 *  it was still holding. */
export const claimedLocalKey = (shareCode: string): string => `code:${shareCode}`;
