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

/** One claimed list this browser has actually had open, and when. The device
 *  registry keeps this per row; a claimed open has no row to keep it in, so it's
 *  kept separately — see useClaimedLists' opens ledger. */
export interface ClaimedOpen {
  shareCode: string;
  lastOpened: number;
}

/**
 * Where the bare address lands: the list this browser opened most recently, or null
 * when it has opened none (→ a fresh draft).
 *
 * BOTH WAYS IN COUNT. The registry half is the lists this browser holds the edit
 * link for; the claimed half is the lists it has opened through the account, at
 * /e/{code} on the session. Ranking only the first half is why the bare address —
 * which is the installed app's start_url, so it IS the offline launch — could hand
 * you a list you hadn't touched in weeks: a list made on another device arrives here
 * as a claimed row, and opening it wrote nothing the resume could see. It has an
 * on-device copy like any other open list (the editor persists one under its share
 * code), so there was never anything missing but the pointer to it.
 *
 * A row with no edit token is still skipped. A list that is in BOTH — opened through
 * the account here, and through its edit link — is one list: it is ranked by
 * whichever open was later and reached through the edit link, which works signed
 * out and offline. The later open can well be the claimed one: a signed-in /e/{code}
 * with no fragment takes the claimed path even when this browser holds the token,
 * and stamps only the ledger — discarding that stamp let an older list win.
 *
 * Ties keep this order — device rows first, then registry order — so an entry from
 * before lastOpened existed still resolves, and a claimed open never displaces a
 * token for the same instant. Only finite stamps count: nothing compares greater
 * than a NaN, so one considered first would otherwise sit at the top for good.
 */
export function resumeTarget(
  device: Pick<MyListEntry, "editToken" | "shareCode" | "lastOpened">[],
  claimed: ClaimedOpen[] = [],
): { to: string; shareCode: string } | null {
  const finite = (n: number | undefined) => (Number.isFinite(n) ? (n as number) : 0);
  const stamped = new Map<string, number>();
  for (const c of claimed) if (c.shareCode) stamped.set(c.shareCode, finite(c.lastOpened));
  let best: { to: string; shareCode: string; at: number } | undefined;
  const consider = (to: string, shareCode: string, at: number) => {
    if (!best || at > best.at) best = { to, shareCode, at };
  };
  const held = new Set<string>();
  for (const e of device) {
    if (!e.editToken) continue;
    held.add(e.shareCode);
    consider(
      editLinkPath(e.shareCode, e.editToken),
      e.shareCode,
      Math.max(finite(e.lastOpened), stamped.get(e.shareCode) ?? 0),
    );
  }
  for (const c of claimed) {
    if (!c.shareCode || held.has(c.shareCode)) continue;
    consider(claimedEditPath(c.shareCode), c.shareCode, finite(c.lastOpened));
  }
  return best ? { to: best.to, shareCode: best.shareCode } : null;
}
