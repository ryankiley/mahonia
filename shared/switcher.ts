// The list switcher's rows: this browser's registry MERGED with the account's
// claimed lists. Pure + framework-agnostic (so it's unit-testable), like
// localList.ts; the Vue wiring lives in app/components/ListMenu.vue.
//
// The two sources answer different questions — "what does this browser hold the
// edit link for" and "what does this account hold" — and a list you use across
// devices is usually in both. One row per LIST: a device row wins the collision,
// because the edit link it carries works signed out and offline, where a claimed
// row is only as good as the session behind it.

import { claimedEditPath, editLinkPath } from "./links";
import type { MyListEntry } from "./types";

/** What the switcher needs to render one list, whichever side it came from. */
export interface SwitcherRow {
  /** Stable render key: the edit token, or `code:{shareCode}` for a claimed-only row. */
  key: string;
  title: string;
  /** Where the row navigates: /e/{code}#{token}, or /e/{code} for a claimed-only
   *  row (the session is the way in — see server/utils/editAuth). */
  to: string;
  /** "" on legacy device entries that predate share codes. */
  shareCode: string;
}

/** The slice of a claimed list the merge needs — structural, so the client
 *  composable's shape and the server repo's shape both satisfy it. */
export interface ClaimedRowSource {
  shareCode: string;
  slug: string;
  title: string;
}

/**
 * One row per list, device rows first claim on identity.
 *
 * A claimed list is matched to a device row by SHARE CODE, falling back to SLUG
 * for registry entries from before pretty links (#54) whose shareCode is "" —
 * without the fallback those legacy rows would stand beside their own claimed
 * twin, which is exactly the duplicate-row bug the registry's upsert exists to
 * prevent. Slugs are minted once at create and never re-cut, so the match is safe.
 *
 * No sorting here: the switcher owns display order (it sorts by title with its
 * own collator), and a second sort rule in a second file is how the two drift.
 */
export function mergeSwitcherRows(
  device: Pick<MyListEntry, "editToken" | "shareCode" | "slug" | "title">[],
  claimed: ClaimedRowSource[],
): SwitcherRow[] {
  const heldCodes = new Set(device.map((e) => e.shareCode).filter(Boolean));
  const heldSlugs = new Set(device.map((e) => e.slug).filter(Boolean));
  const rows: SwitcherRow[] = device.map((e) => ({
    key: e.editToken,
    title: e.title,
    to: editLinkPath(e.shareCode, e.editToken),
    shareCode: e.shareCode,
  }));
  for (const l of claimed) {
    if (heldCodes.has(l.shareCode) || (l.slug && heldSlugs.has(l.slug))) continue;
    rows.push({
      key: `code:${l.shareCode}`,
      title: l.title,
      to: claimedEditPath(l.shareCode),
      shareCode: l.shareCode,
    });
  }
  return rows;
}
