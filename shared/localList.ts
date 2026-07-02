// On-device durability for the editor. The editor queues edits as Ops and flushes
// them to the server; this module backs that queue with the browser's IndexedDB so
// an unsaved draft or an un-acked op survives a reload, a crash, or a dropped
// connection. Pure + framework-agnostic (so it's unit-testable); the IndexedDB
// plumbing lives in app/composables/useLocalListStore.ts.

import { applyOps, type Op } from "./ops";
import type { ListSnapshot } from "./types";

/** A list persisted to this browser's IndexedDB so its edits survive a reload. */
export interface LocalListRecord {
  snapshot: ListSnapshot;
  pending: Op[]; // ops applied locally but not yet acknowledged by the server
  updatedAt: number;
}

/** Fixed key for the single in-progress, not-yet-saved draft (one at a time). */
export const DRAFT_KEY = "__draft__";

/** IndexedDB key for a list: its edit token, or the draft slot before first save. */
export const localKey = (editToken: string): string => editToken || DRAFT_KEY;

/**
 * Rebase un-acked local ops onto the authoritative server snapshot — the same
 * merge the editor's flush() does, but returning a fresh object so the server
 * snapshot passed in is left untouched. Used when hydrating a list on load: the
 * server is the source of truth, with the device's pending edits replayed on top.
 */
export function rebaseOnto(server: ListSnapshot, pending: Op[]): ListSnapshot {
  if (!pending.length) return server;
  const next = structuredClone(server);
  applyOps(next, pending);
  return next;
}
