// Lists attached to the signed-in account — the half of "Your lists" that isn't
// tied to this browser.
//
// The device registry (useMyLists) and this are deliberately BOTH kept. They
// answer different questions: the registry is "what does this browser hold the
// edit link for", which still works signed-out and offline; this is "what does
// this account hold", which survives a cleared browser and a new device. A list
// usually appears in both. The list switcher merges the two for display — one row
// per list, device rows winning the collision (shared/switcher.ts).

import { LIST_CODE_HEADER } from "~~/shared/links";
import { claimedLocalKey } from "~~/shared/localList";
import type { Unit } from "~~/shared/types";
import { remember } from "../utils/remember";

export interface ClaimedList {
  shareCode: string;
  slug: string;
  title: string;
  totalMg: number;
  version: number;
  displayUnit: Unit;
  updatedAt: string;
}

// Which set of device tokens we've already claimed, so a signed-in visitor doesn't
// re-POST the same registry on every page load. Persisted per-device rather than
// held in memory: the claim call would otherwise repeat on every cold navigation.
const CLAIMED_MARK_KEY = "gear.claimed.v1";

export function deviceFingerprint(tokens: string[]): string {
  return [...tokens].sort().join("|");
}

export function useClaimedLists() {
  const lists = useState<ClaimedList[]>("claimed-lists", () => []);
  const loaded = useState<boolean>("claimed-loaded", () => false);
  const { signedIn } = useSession();

  async function refresh(): Promise<void> {
    if (!import.meta.client || !signedIn.value) {
      lists.value = [];
      return;
    }
    try {
      const res = await $fetch<{ lists: ClaimedList[] }>("/api/lists/claimed");
      lists.value = res.lists || [];
      loaded.value = true;
    } catch {
      // signed out mid-flight, or offline — leave whatever we had rather than
      // blanking a list the user is looking at
    }
  }

  /**
   * Attach this browser's lists to the account.
   *
   * Sends the edit tokens from the device registry; the server resolves them to
   * list ids and stores only that (see server/utils/claimRepo.ts), so the account
   * never becomes a store of edit capabilities.
   *
   * Skipped when the registry hasn't changed since the last successful claim —
   * the call is idempotent server-side, but there's no reason to make it on every
   * page load. Creating a new list changes the fingerprint, so it re-runs then.
   */
  async function claimDeviceLists(): Promise<void> {
    if (!import.meta.client || !signedIn.value) return;
    // The registry, split by what this browser knows about each row. Lists it made
    // are claimed outright. Lists that arrived through someone else's edit link go
    // in the second bucket and are NOT claimed for being there — quietly attaching
    // a shared list to your account is a surprise, and a claim is meant to be a
    // private bookmark rather than a second, invisible way in.
    //
    // They're sent at all because that mark is unreliable in one direction: a list
    // from before `origin` existed gets stamped "opened" merely by being reopened
    // through its own link, which used to strand it on this device forever. Only
    // the server can tell that era apart (it has the list's creation date), so the
    // decision belongs to it — see server/utils/claimRepo.
    const entries = useMyLists().entries.value;
    const editTokens = entries.filter((e) => e.origin !== "opened").map((e) => e.editToken);
    const openedTokens = entries.filter((e) => e.origin === "opened").map((e) => e.editToken);
    // Both buckets, so a registry that changes only in its opened rows still
    // re-runs the sweep. (It also retires every mark written by the version that
    // fingerprinted one bucket — which is what re-sweeps the lists this bug had
    // already stranded, without anything to migrate.)
    const mark = deviceFingerprint([...editTokens, ...openedTokens]);
    let seen = "";
    try {
      seen = localStorage.getItem(CLAIMED_MARK_KEY) ?? "";
    } catch {
      // storage blocked — fall through and claim; it's idempotent
    }
    if ((editTokens.length || openedTokens.length) && mark === seen) {
      // nothing new to attach, but we still want the account's own list
      if (!loaded.value) await refresh();
      return;
    }
    try {
      const res = await $fetch<{ claimed: number; lists: ClaimedList[] }>("/api/lists/claim", {
        method: "POST",
        body: { editTokens, openedTokens },
      });
      lists.value = res.lists || [];
      loaded.value = true;
      remember(CLAIMED_MARK_KEY, mark); // a blocked write just means claiming again next time
    } catch {
      // offline or rate-limited: leave the mark unset so the next load retries
    }
  }

  /** Attach ONE list to the account, by presenting its edit token — the explicit
   *  counterpart of the automatic sweep above, for a list someone shared with you.
   *  Deliberately a choice rather than a side effect of signing in. */
  async function claimOne(editToken: string): Promise<boolean> {
    try {
      const res = await $fetch<{ lists: ClaimedList[] }>("/api/lists/claim", {
        method: "POST",
        body: { editTokens: [editToken] },
      });
      lists.value = res.lists || [];
      loaded.value = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Mirror an edit made THROUGH a claimed open onto its row here, so the switcher
   *  reads the new title/total straight away instead of one refetch later — the
   *  claimed-side twin of useMyLists().touch(). In-memory only: the server already
   *  holds the truth (the edit just saved to it), and the next refresh re-reads it. */
  function touchByCode(
    shareCode: string,
    patch: Partial<Pick<ClaimedList, "title" | "version" | "totalMg" | "displayUnit">>,
  ): void {
    lists.value = lists.value.map((l) => (l.shareCode === shareCode ? { ...l, ...patch } : l));
  }

  /** Delete a claimed list via the session (no edit token on this device — the
   *  code names it, the cookie proves it; see server/utils/editAuth). Same 404
   *  contract as useMyLists().deleteList: already-gone counts as done, any other
   *  failure leaves everything standing so the user can retry. */
  async function deleteClaimed(shareCode: string): Promise<boolean> {
    try {
      await $fetch("/api/edit/delete", {
        method: "POST",
        headers: { [LIST_CODE_HEADER]: shareCode },
      });
    } catch (e) {
      if ((e as { statusCode?: number })?.statusCode !== 404) return false;
    }
    lists.value = lists.value.filter((l) => l.shareCode !== shareCode);
    // drop the claimed open's on-device copy too — the list is gone for good
    useLocalListStore().del(claimedLocalKey(shareCode));
    return true;
  }

  /** Detach a list from the account. The list itself is untouched — anyone holding
   *  its edit link, this user included, can still open it. */
  async function unclaim(shareCode: string): Promise<boolean> {
    try {
      const res = await $fetch<{ ok: boolean }>("/api/lists/unclaim", {
        method: "POST",
        body: { shareCode },
      });
      if (res.ok) lists.value = lists.value.filter((l) => l.shareCode !== shareCode);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Forget the device-claim marker — on sign-out, so the next account signed in
   *  on this browser claims its own registry rather than seeing ours already done. */
  function resetClaimMark(): void {
    if (!import.meta.client) return;
    try {
      localStorage.removeItem(CLAIMED_MARK_KEY);
    } catch {
      // nothing to do; the mark is an optimisation, not state we depend on
    }
    lists.value = [];
    loaded.value = false;
  }

  return {
    lists,
    loaded,
    refresh,
    claimDeviceLists,
    claimOne,
    touchByCode,
    deleteClaimed,
    unclaim,
    resetClaimMark,
  };
}
