// Lists attached to the signed-in account — the half of "Your lists" that isn't
// tied to this browser.
//
// The device registry (useMyLists) and this are deliberately BOTH kept. They
// answer different questions: the registry is "what does this browser hold the
// edit link for", which still works signed-out and offline; this is "what does
// this account hold", which survives a cleared browser and a new device. A list
// usually appears in both. The list switcher merges the two for display — one row
// per list, device rows winning the collision (shared/switcher.ts).

import { LIST_CODE_HEADER, normalizeShareCode } from "~~/shared/links";
import { claimedLocalKey } from "~~/shared/localList";
import { isRecord } from "~~/shared/record";
import type { ClaimedOpen } from "~~/shared/switcher";
import { CLAIMED_LIST_CAP, type ClaimedList } from "~~/shared/types";
import { forget, recall, recallJson, remember } from "../utils/remember";
import { sessionCacheOwner } from "../utils/sessionOwner";
import { deleteListOnServer } from "./useMyLists";


// Which set of device tokens we've already claimed, so a signed-in visitor doesn't
// re-POST the same registry on every page load. Persisted per-device rather than
// held in memory: the claim call would otherwise repeat on every cold navigation.
const CLAIMED_MARK_KEY = "gear.claimed.v2";

// The account's rows as this browser last saw them. A cache, not a source: the
// server owns the truth and every successful read below replaces this wholesale.
//
// It exists because the account half of "your lists" is fetched, and a fetch is the
// one thing an offline launch cannot do — /api/auth/me fails first, so a signed-in
// visitor even READS as signed out, and the switcher would show only the lists this
// browser holds edit links for. The lists made on another device would vanish from
// it exactly when there's no network to ask for them back, which is the moment the
// app is least able to explain itself.
const CLAIMED_ROWS_KEY = "gear.claimed.rows.v2";

// When this browser last had each claimed list OPEN. The device registry keeps this
// per row (MyListEntry.lastOpened); a claimed open has no registry row — the point
// of it is that this device holds no edit token — so it's kept here instead, and
// the bare address ranks the two together (shared/switcher resumeTarget).
const CLAIMED_OPENS_KEY = "gear.claimed.opens.v2";

const LEGACY_KEYS = ["gear.claimed.v1", "gear.claimed.rows.v1", "gear.claimed.opens.v1"];

const ownedKey = (base: string, owner: string | null) =>
  owner === null ? null : `${base}.${owner}`;

/** The cookie is current even while an old /api/auth/me response is still on screen. */
function cacheOwner(): string | null {
  return sessionCacheOwner() ?? useSession().user.value?.owner ?? null;
}

function forgetLegacyCache(): void {
  for (const key of LEGACY_KEYS) forget(key);
}

// Enough to cover any plausible rotation of lists; the ledger is only ever read to
// find the single most recent, so the tail is dead weight and old codes shouldn't
// accumulate on the device forever.
const OPENS_KEPT = 32;

function readOpens(owner = cacheOwner()): Record<string, number> {
  // Only what this file itself writes gets through: a canonical share code as the
  // key, a finite stamp as the value. Anything else — an array, "__proto__", a
  // stamp stored as a string — would become a resume target (/e/0) or sort as NaN
  // and evict the real stamps on the next write. A corrupt ledger reads as empty
  // (recallJson) rather than taking the bare address down with it — the same shrug
  // the device registry makes about its own store.
  const key = ownedKey(CLAIMED_OPENS_KEY, owner);
  if (!key) return {};
  const clean: Record<string, number> = {};
  for (const [code, at] of Object.entries(recallJson(key, isRecord, {}))) {
    if (normalizeShareCode(code) === code && typeof at === "number" && Number.isFinite(at)) {
      clean[code] = at;
    }
  }
  return clean;
}

/** Every claimed list this browser has had open, newest first. Read by the bare
 *  address; a plain function rather than a composable so the resume middleware can
 *  call it without booting anything. */
export function claimedOpens(): ClaimedOpen[] {
  return Object.entries(readOpens())
    .map(([shareCode, lastOpened]) => ({ shareCode, lastOpened }))
    .sort((a, b) => b.lastOpened - a.lastOpened);
}

/** Note that this browser has this claimed list open NOW — the claimed twin of the
 *  registry's touch(). Called from the editor on every sync, so an open that only
 *  ever happened offline (hydrated from the on-device copy) counts too. */
export function markClaimedOpen(shareCode: string): void {
  // Keyed by the CANONICAL code, the spelling the reader accepts and the rows carry;
  // callers already pass that (load() normalizes claimCode), so this is the writer
  // keeping the promise the reader enforces, and a non-code is a no-op.
  const code = normalizeShareCode(shareCode);
  if (!import.meta.client || !code) return;
  // No account behind this browser, no stamp. A tab still holding a claimed list
  // open after a sign-out in ANOTHER tab would otherwise re-create the ledger that
  // sign-out had just cleared, for whoever signs in here next; the cookie is shared
  // across tabs, so this one knows before its own session state has caught up.
  if (useSession().presence.value === "signedOut") return;
  const owner = cacheOwner();
  const key = ownedKey(CLAIMED_OPENS_KEY, owner);
  if (!key) return;
  const opens = readOpens(owner);
  opens[code] = Date.now();
  const kept = Object.entries(opens)
    .sort((a, b) => b[1] - a[1])
    .slice(0, OPENS_KEPT);
  remember(key, JSON.stringify(Object.fromEntries(kept)));
}

/** Drop one code from the ledger: the list is gone, detached, or the claim no
 *  longer opens it, so the bare address must stop offering to resume it. */
export function forgetClaimedOpen(shareCode: string): void {
  const code = normalizeShareCode(shareCode);
  if (!import.meta.client || !code) return;
  const owner = cacheOwner();
  const key = ownedKey(CLAIMED_OPENS_KEY, owner);
  if (!key) return;
  const opens = readOpens(owner);
  if (!(code in opens)) return;
  delete opens[code];
  remember(key, JSON.stringify(opens));
}

/** Drop every ledger code not in `keep` — the account's rows as the server has just
 *  returned them, which is the one moment the ledger can be held against the truth.
 *  A list unclaimed or deleted on ANOTHER device never answers 401 here (nothing on
 *  this device asks about it until the bare address resumes into it), so without
 *  this the launch after such a change went straight to a list the account no
 *  longer held — offline, into its stale copy as "offline", with no way to notice. */
export function pruneClaimedOpens(keep: Iterable<string>, owner = cacheOwner()): void {
  if (!import.meta.client) return;
  const key = ownedKey(CLAIMED_OPENS_KEY, owner);
  if (!key) return;
  const live = new Set([...keep].map(normalizeShareCode));
  const opens = readOpens(owner);
  const kept = Object.fromEntries(Object.entries(opens).filter(([code]) => live.has(code)));
  if (Object.keys(kept).length === Object.keys(opens).length) return; // nothing to drop, no write
  remember(key, JSON.stringify(kept));
}

const isClaimedRow = (r: unknown): r is ClaimedList =>
  !!r && typeof r === "object" && typeof (r as ClaimedList).shareCode === "string";

function readCachedRows(owner = cacheOwner()): ClaimedList[] {
  // Element by element, not just "is it an array": a null or a number in here would
  // reach mergeSwitcherRows and registryStale as `l.shareCode` and throw — in the
  // switcher's render, and on every keystroke of a claimed open.
  const key = ownedKey(CLAIMED_ROWS_KEY, owner);
  return key ? recallJson(key, Array.isArray, []).filter(isClaimedRow) : [];
}

/** The registry as one comparable string. Exported so the session plugin, which
 *  watches for the registry to change, computes the same value it then passes in
 *  here — one fingerprint per change, not one per watcher and one per claim. */
export function deviceFingerprint(tokens: string[]): string {
  return [...tokens].sort().join("|");
}

// Whether this page load has started following the rows cache across tabs — once
// per page, whichever call gets there first (see restoreFromDevice).
let following = false;

export function useClaimedLists() {
  const lists = useState<ClaimedList[]>("claimed-lists", () => []);
  const loaded = useState<boolean>("claimed-loaded", () => false);
  const { signedIn, hasSessionHint, presence } = useSession();

  /** Adopt rows and mirror them to the device, so the next cold load — which may
   *  have no network — starts from what this browser last knew. The ONE owner of the
   *  cache: no rows means no key, never a stored "[]", so the many visitors with no
   *  account leave nothing behind and "empty" reads the same either way. */
  function adopt(rows: ClaimedList[], owner = cacheOwner()): void {
    lists.value = rows;
    const key = ownedKey(CLAIMED_ROWS_KEY, owner);
    if (!key) return;
    forgetLegacyCache();
    if (rows.length) remember(key, JSON.stringify(rows));
    else forget(key);
  }

  /** The server's answer, adopted whole — and held against the opens ledger (see
   *  pruneClaimedOpens), unless it hit the server's cap, when the rows in hand are
   *  not the whole account and nothing outside them can be called gone. */
  function adoptFromServer(rows: ClaimedList[], owner = cacheOwner()): void {
    adopt(rows, owner);
    if (rows.length < CLAIMED_LIST_CAP) pruneClaimedOpens(rows.map((r) => r.shareCode), owner);
  }

  /**
   * The cached rows, read ONCE at boot (app/plugins/session.client.ts) — before any
   * component, middleware or fetch — so the switcher opens to what this browser last
   * knew of the account until a read answers. Only with an account plausibly behind
   * the browser: offline, /api/auth/me never answers and that is the hint cookie
   * standing in ("presumed"), which is the whole reason the cache exists. Once and
   * here, rather than as a side effect of every useClaimedLists() call, which ran
   * the same guard on every dispatch of a claimed open. Assigned only when the cache
   * HAS rows: a fresh empty array is a change to a ref even over an empty one.
   *
   * It also starts FOLLOWING the cache across tabs: another tab's read replaces the
   * rows here as it lands, and its sign-out empties them — the way the device
   * registry already follows its own key — so a sign-in or sign-out in one tab
   * reaches the switcher in the others without a reload. The ledger needs no
   * follower: it is read from storage on every use.
   */
  function restoreFromDevice(): void {
    if (!import.meta.client) return;
    if (presence.value !== "signedOut" && !loaded.value && !lists.value.length) {
      const cached = readCachedRows();
      if (cached.length) lists.value = cached;
    }
    if (following) return;
    following = true;
    window.addEventListener("storage", (e) => {
      // a null key is the other tab clearing storage outright — read again either way
      const key = ownedKey(CLAIMED_ROWS_KEY, cacheOwner());
      if (!key || (e.key !== null && e.key !== key)) return;
      lists.value = readCachedRows();
    });
  }

  async function refresh(): Promise<void> {
    if (!import.meta.client) return;
    // Resolved signed-out, yet the hint cookie is back: another tab signed in since
    // this one asked. Ask again before deciding anything on that stale answer — the
    // blank below would have thrown away the rows that tab had just cached.
    if (presence.value === "signedOut" && hasSessionHint()) await useSession().refresh(true);
    if (presence.value === "signedOut") {
      // Blank ONLY on a RESOLVED signed-out session. Offline the session read fails
      // and the hint stands in ("presumed"), so the cached rows stay — the switcher
      // would otherwise go from "4 lists" to "1 list" the second the tunnel started.
      // The whole account half goes, the ledger included: a claimed resume is only
      // as good as the session, and this is the session saying it is over.
      // (useSession does the same the moment the server answers "no user", so by
      // the time the switcher opens this is usually already done.)
      resetClaimMark();
      return;
    }
    if (!signedIn.value) return; // presumed: nothing to ask with yet, nothing to throw away
    const owner = cacheOwner();
    if (!owner) return;
    try {
      const res = await $fetch<{ lists: ClaimedList[] }>("/api/lists/claimed");
      if (owner !== cacheOwner()) return;
      adoptFromServer(res.lists || [], owner);
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
   * `fingerprint` is that value when the caller already has it (the session plugin
   * computed it to notice the change); otherwise it's taken here.
   */
  async function claimDeviceLists(fingerprint?: string): Promise<void> {
    if (!import.meta.client || !signedIn.value) return;
    const owner = cacheOwner();
    const markKey = ownedKey(CLAIMED_MARK_KEY, owner);
    if (!markKey) return;
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
    const mark = fingerprint ?? deviceFingerprint([...editTokens, ...openedTokens]);
    // storage blocked reads as "" — fall through and claim; it's idempotent
    const seen = recall(markKey) ?? "";
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
      if (owner !== cacheOwner()) return;
      adoptFromServer(res.lists || [], owner);
      loaded.value = true;
      remember(markKey, mark); // a blocked write just means claiming again next time
    } catch {
      // offline or rate-limited: leave the mark unset so the next load retries
    }
  }

  /** Attach ONE list to the account, by presenting its edit token — the explicit
   *  counterpart of the automatic sweep above, for a list someone shared with you.
   *  Deliberately a choice rather than a side effect of signing in. */
  async function claimOne(editToken: string): Promise<boolean> {
    const owner = cacheOwner();
    if (!owner) return false;
    try {
      const res = await $fetch<{ lists: ClaimedList[] }>("/api/lists/claim", {
        method: "POST",
        body: { editTokens: [editToken] },
      });
      if (owner !== cacheOwner()) return false;
      adoptFromServer(res.lists || [], owner);
      loaded.value = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Mirror an edit made THROUGH a claimed open onto its row here, so the switcher
   *  reads the new title/total straight away instead of one refetch later — the
   *  claimed-side twin of useMyLists().touch(). IN MEMORY ONLY: the server holds the
   *  truth and the next read replaces the device cache from it. Writing the cache
   *  from here would write this TAB's idea of the account over the last real answer
   *  — stale rows after a sign-out in another tab, or nothing at all before the first
   *  read has landed. The "you had this open" half is markClaimedOpen, which the
   *  editor calls alongside this. */
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
    const owner = cacheOwner();
    if (!owner) return false;
    if (!(await deleteListOnServer({ [LIST_CODE_HEADER]: shareCode }))) return false;
    if (owner !== cacheOwner()) return false;
    adopt(lists.value.filter((l) => l.shareCode !== shareCode), owner);
    // drop the claimed open's on-device copy too — the list is gone for good, so
    // the bare address must stop offering to resume it as well
    useLocalListStore().del(claimedLocalKey(shareCode));
    forgetClaimedOpen(shareCode);
    return true;
  }

  /** Detach a list from the account. The list itself is untouched — anyone holding
   *  its edit link, this user included, can still open it. */
  async function unclaim(shareCode: string): Promise<boolean> {
    const owner = cacheOwner();
    if (!owner) return false;
    try {
      const res = await $fetch<{ ok: boolean }>("/api/lists/unclaim", {
        method: "POST",
        body: { shareCode },
      });
      // the list itself survives, but this account is no longer a way into it —
      // and a claimed resume is only as good as that claim
      if (res.ok) {
        if (owner !== cacheOwner()) return false;
        adopt(lists.value.filter((l) => l.shareCode !== shareCode), owner);
        forgetClaimedOpen(shareCode);
      }
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Forget the device-claim marker — on sign-out, so the next account signed in
   *  on this browser claims its own registry rather than seeing ours already done. */
  function resetClaimMark(owner = cacheOwner()): void {
    if (!import.meta.client) return;
    const markKey = ownedKey(CLAIMED_MARK_KEY, owner);
    const rowsKey = ownedKey(CLAIMED_ROWS_KEY, owner);
    const opensKey = ownedKey(CLAIMED_OPENS_KEY, owner);
    if (markKey) forget(markKey); // a blocked remove is nothing to do about; the mark is an optimisation, not state we depend on
    // the cached rows and the opens ledger are this account's too: leaving either
    // behind would show the last person's lists in the switcher, and could resume
    // the bare address into one of them
    if (rowsKey) forget(rowsKey);
    if (opensKey) forget(opensKey);
    forgetLegacyCache();
    lists.value = [];
    loaded.value = false;
  }

  return {
    lists,
    loaded,
    restoreFromDevice,
    refresh,
    claimDeviceLists,
    claimOne,
    touchByCode,
    deleteClaimed,
    unclaim,
    resetClaimMark,
  };
}
