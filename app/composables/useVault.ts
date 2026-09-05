// The vault's two client jobs: quietly remembering the gear you put in a list,
// and offering it back the next time you build one.

import type { Folder, Item } from "~~/shared/types";
import type { VaultCapture, VaultEntry, VaultGearKey } from "~~/shared/vault";
import { remember } from "../utils/remember";

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// whose gear is this?
// ---------------------------------------------------------------------------
// A list you MADE is unambiguously yours, and its gear goes to your vault without
// asking. An edit link you merely hold is not: it's your own list opened on a
// second device, or one a friend sent you, and nothing in the link tells the two
// apart. Rather than guess — and quietly copy a stranger's kit into your locker —
// the editor asks once per list and remembers the answer.
//
// Per LIST, keyed by its edit token (already this device's IndexedDB key for the
// list, so no new exposure). Device-local: it's a judgement about your own vault,
// never sent anywhere.
const DECISION_KEY = (editToken: string) => `gear.vault.for.${editToken}`;

type VaultDecision = "yes" | "no" | "ask";

export function vaultDecisionFor(editToken: string): VaultDecision {
  if (!import.meta.client || !editToken) return "yes"; // a draft is yours by definition
  try {
    const v = localStorage.getItem(DECISION_KEY(editToken));
    return v === "yes" || v === "no" ? v : "ask";
  } catch {
    return "ask";
  }
}

export function setVaultDecisionFor(editToken: string, decision: "yes" | "no"): void {
  if (editToken) remember(DECISION_KEY(editToken), decision);
}

// "Yes" is rarely the whole truth on a list you shared. On a trip you planned
// together you brought the tent and they brought the stove, and the vault is
// meant to be YOUR gear — so answering Add opens a chooser, and what you leave
// unticked is remembered as not-yours FOR THIS LIST.
//
// An exclusion list rather than an allow list, deliberately: the set you're
// declining is a fact about gear that's in the list today, whereas an allow list
// would silently exclude everything you add tomorrow — and gear you add to a list
// yourself is exactly the gear most likely to be yours.
const EXCLUDE_KEY = (editToken: string) => `gear.vault.not.${editToken}`;

/** The normKeys this device said were somebody else's, for this list. */
export function vaultExclusionsFor(editToken: string): Set<string> {
  if (!import.meta.client || !editToken) return new Set();
  try {
    const raw = localStorage.getItem(EXCLUDE_KEY(editToken));
    const parsed = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set(); // unreadable or malformed — capture everything rather than nothing
  }
}

export function setVaultExclusionsFor(editToken: string, normKeys: string[]): void {
  if (!editToken) return;
  try {
    if (normKeys.length) localStorage.setItem(EXCLUDE_KEY(editToken), JSON.stringify(normKeys));
    else localStorage.removeItem(EXCLUDE_KEY(editToken));
  } catch {
    /* storage blocked — the choice holds for this session only */
  }
}

/**
 * Drop this device's answer for a list — both halves of it, the yes/no and the
 * exclusions that refine a yes. They're keyed by the same edit token and they
 * die together.
 *
 * For a token that is dead for good, and only that: the list was deleted, or a
 * forget of a token the server had already stopped answering — from the dead-end
 * page, or from the ⋯ menu in its "No longer online · saved on device" state.
 * Deliberately not part of useMyLists.forget() itself, which also backs "Forget
 * this list" on a list that is still online: there the edit link may well bring
 * the list back, so "no, that gear isn't mine" is an answer worth keeping —
 * clearing it would re-ask a question already answered. A dead token's answer is
 * the one that's definitively unreachable (the keys are found only through the
 * token), and nothing else ever removed these keys, so every delete used to leave
 * a pair of them behind for good.
 */
export function clearVaultDecisionFor(editToken: string): void {
  if (!editToken) return;
  try {
    localStorage.removeItem(DECISION_KEY(editToken));
    localStorage.removeItem(EXCLUDE_KEY(editToken));
  } catch {
    /* storage blocked — then there was nothing stored to remove */
  }
}

/** How long the editor must be idle before a capture goes out. Long enough that
 *  typing an item name is one write rather than one per keystroke; short enough
 *  that a list closed shortly after editing has already been captured. */
const CAPTURE_DEBOUNCE_MS = 4_000;

// Module scope, not per-instance: the editor is a singleton controller, and the
// fingerprint is what stops an unchanged list re-POSTing on every dispatch.
let lastFingerprint = "";
let timer: ReturnType<typeof setTimeout> | undefined;
// Capture rows built and waiting: either for the debounce to elapse, or for a
// retry after a failed send. Held as built rows (not raw items) so the page-hide
// flush can beacon them synchronously — it has no chance to await anything.
let pending: { items: VaultCapture[]; fingerprint: string } | null = null;

/**
 * Capture the gear in a list into this device's vault.
 *
 * WHY THE LIST, NOT THE KEYSTROKE: an item can reach a list a dozen ways — typed,
 * picked from the catalog, imported from LighterPack, cloned, dragged out of a
 * group. Hooking each of those would mean a dozen call sites and a permanent
 * opportunity to add a thirteenth that forgets. Reading the resulting list instead
 * catches every path by construction, and it reads the SETTLED row (name, weight
 * and classification all present) rather than a half-finished one.
 *
 * The shared vault module is imported DYNAMICALLY, so the code that folds a list
 * into capture rows is downloaded only when a capture actually happens — the same
 * treatment the offline catalog cache gets, and for the same reason (the editor's
 * bundle is budgeted).
 */
/** Why a hand press did or didn't land. Each value is a different thing for the
 *  row to SAY: a row to finish, a removal to undo on /gear, a full vault to make
 *  room in, a request worth retrying. */
export type CaptureOneResult = "saved" | "unworthy" | "removed" | "full" | "failed";

export function useVaultCapture() {
  // hasVault as well as the fetch: capture must not ASK someone who has no vault
  // (see sync below), and the two come from the same place.
  const { hasVault, vaultFetch } = useVaultAccess();

  /**
   * Note a change to the list.
   *
   * The capture rows are built EAGERLY (it's a cheap pass over the list) and only
   * the network write is debounced — so if the tab closes mid-debounce there's
   * something ready to beacon out. A no-op when nothing a vault row actually
   * stores has changed.
   *
   * Note there is no "do you have a vault" guard: the FIRST capture is what brings
   * a vault into being (the endpoint mints one and returns its token), so gating on
   * having a token would mean never getting one.
   */
  function sync(
    items: Item[],
    folders: Folder[] = [],
    opts: {
      editToken?: string;
      onAsk?: () => void;
      /** What the vault holds of this list's gear, or null while unanswered —
       *  the open list's own answer, handed in by the controller. */
      held?: ReadonlyMap<string, number | null> | null;
    } = {},
  ): void {
    if (!import.meta.client) return;
    void (async () => {
      let built: { caps: VaultCapture[]; fingerprint: string } | null = null;
      try {
        const { captureFromList, captureFingerprint } = await import("~~/shared/vault");
        const all = captureFromList(items, folders);
        if (!all.length) return;
        // Gear declined in the chooser stays declined on every later edit — this is
        // what makes "only the tent is mine" a standing answer rather than a
        // one-off, since capture otherwise re-offers the whole list every time.
        const declined = vaultExclusionsFor(opts.editToken ?? "");
        const caps = declined.size ? all.filter((c) => !declined.has(c.normKey)) : all;
        if (!caps.length) return;
        // The decision is consulted HERE, after the capture set is built, so a list
        // with nothing vault-worthy in it never raises the question. Asking whether
        // to add gear when there is no gear is a question whose answer changes
        // nothing — and it burned the one chance to ask about that list.
        const decision = vaultDecisionFor(opts.editToken ?? "");
        if (decision === "no") return;
        // Only ask someone who HAS a vault to ask about. Signed out there is nothing
        // to add gear to, and the prompt offered one anyway: "Add" recorded the
        // decision as yes and then 401'd, spending the single question this list
        // gets. Leaving it unanswered is right — the question fires properly the
        // first time you edit this list with an account.
        // ...and only about gear there is still something to decide. The whole
        // reason a list you built on another device asks at all is that the
        // per-list answer lives in localStorage and this device has never seen it
        // — but the vault itself can now be asked, and when it already holds
        // every row there is nothing to consent to and nothing to move. The rows
        // correctly stand their save buttons down in that state; asking anyway
        // put a modal over a list to request permission for a no-op, and spent
        // the one question that list gets.
        if (decision === "ask") {
          if (!hasVault.value) return;
          const held = opts.held;
          if (held && caps.every((c) => held.has(c.normKey))) return;
          return opts.onAsk?.();
        }
        built = { caps, fingerprint: captureFingerprint(caps) };
      } catch {
        return; // chunk fetch failed (offline before the SW cached it) — skip
      }
      // already stored, or already queued for exactly this state
      if (built.fingerprint === lastFingerprint || built.fingerprint === pending?.fingerprint) return;
      pending = { items: built.caps, fingerprint: built.fingerprint };
      clearTimeout(timer);
      timer = setTimeout(send, CAPTURE_DEBOUNCE_MS);
    })();
  }

  async function send(): Promise<void> {
    const sending = pending;
    if (!sending) return;
    try {
      await vaultFetch("/api/vault/capture", {
        method: "POST",
        body: { items: sending.items },
      });
      // Nothing is fed back to the rows from here, and nothing needs to be: this
      // path runs ONLY when the list's stored answer is "yes" (sync returns above
      // for "no" and for "ask"), which is exactly when vaultAuto already covers
      // every worthy row it sends. Rows the chooser declined aren't in the payload
      // at all. So the automatic path can never change what a button renders, and
      // the epoch that used to carry this response across a sign-out went with it.
      lastFingerprint = sending.fingerprint;
      // only clear if nothing newer arrived while this was in flight
      if (pending?.fingerprint === sending.fingerprint) pending = null;
    } catch {
      // Offline, rate-limited, or the token no longer resolves. Leave the rows
      // pending so the page-hide flush (or the next edit) retries. Capture is a
      // background convenience — it must never surface an error over the list.
    }
  }

  /**
   * Last chance to get a pending capture out as the page goes away — both the
   * debounce still counting down and a send that failed.
   *
   * sendBeacon, not fetch: an in-flight fetch is routinely killed when the
   * document unloads, whereas a beacon is handed to the browser and delivered
   * after the page is gone. The JSON blob's content type keeps the endpoint's body
   * reader happy.
   *
   * A beacon can't set headers, which under link ownership meant the capture
   * endpoint had to accept its capability in the body. It doesn't any more: a
   * beacon is same-origin, so the session cookie goes along by itself and this is
   * just the items.
   */
  function flush(): void {
    if (!import.meta.client || !pending || !navigator.sendBeacon) return;
    const blob = new Blob([JSON.stringify({ items: pending.items })], {
      type: "application/json",
    });
    // NOTHING is noted here, deliberately. A beacon has no response, and
    // sendBeacon's boolean says the browser QUEUED the payload — not that the
    // endpoint accepted it, which it may not (an expired session 401s, the rate
    // limit 429s). This handler also runs on an ordinary tab-background, so the
    // page usually comes back: claiming those keys banked would strip the save
    // button off every row of a list whose capture never landed.
    // The memo IS set on sendBeacon's boolean, which only says the browser queued
    // the payload — so a beacon the endpoint later refuses (an expired session,
    // the rate limit) is never retried, because sync() will match the same
    // fingerprint and return. That is a real hole, and it is NOT this change's to
    // close: "does not also POST what it already beaconed" is a deliberate,
    // tested decision about double-sending, and reversing it trades one loss for
    // another. Left as found, and flagged.
    if (navigator.sendBeacon("/api/vault/capture", blob)) {
      lastFingerprint = pending.fingerprint;
      pending = null;
    }
  }

  /**
   * Flush a pending capture when the page goes away. Call once, inside an effect
   * scope that lives as long as the editor controller does.
   *
   * `pagehide` rather than `beforeunload`: it's the event that actually fires when
   * mobile Safari backgrounds a tab, which is how most phone sessions end.
   * `visibilitychange` is belt-and-braces for the Androids that skip pagehide.
   */
  function bindFlushOnLeave(): void {
    if (!import.meta.client) return;
    useWindowEvent("pagehide", flush);
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    // visibilitychange is a DOCUMENT event, so it doesn't fit useWindowEvent's
    // WindowEventMap signature — bound by hand, released with the scope
    document.addEventListener("visibilitychange", onHide);
    onScopeDispose(() => {
      document.removeEventListener("visibilitychange", onHide);
      clearTimeout(timer);
    });
  }

  /**
   * Capture a list that arrived WHOLE — imported from LighterPack, or cloned from
   * someone's public list. Its gear reaches the client in one server response
   * rather than through ops, so nothing else would ever offer it to the vault.
   *
   * Called at the moment of creation rather than from the editor's load(), even
   * though load() is one hook and this is two call sites. Capturing on OPEN cannot
   * tell your own list opened on a second device from an edit link a friend sent
   * you — both are just a token this browser holds — so it quietly copied other
   * people's gear into your vault, and minted a vault for a collaborator who had
   * never asked for one. Creation is unambiguous: this device made this list, from
   * this data, just now.
   */
  function captureNewList(
    snapshot: { items: Item[]; folders?: Folder[] },
    editToken: string,
  ): void {
    // Recording the answer, not just capturing: you made this list, so its gear is
    // yours and the editor must never go on to ask about it. Without this an
    // imported or cloned list captured once here and then, on your very next edit,
    // asked whether the gear you had just imported was really yours.
    setVaultDecisionFor(editToken, "yes");
    sync(snapshot.items, snapshot.folders ?? [], { editToken });
  }

  /**
   * The capture rows a list would contribute, for the chooser to show.
   *
   * Same builder the automatic path uses — the chooser must offer exactly what
   * would otherwise have been taken, or the tick boxes are describing something
   * else. Behind the same dynamic import, so asking for the list is what pulls the
   * chunk rather than the editor carrying it.
   */
  async function buildCaptures(items: Item[], folders: Folder[] = []): Promise<VaultCapture[]> {
    if (!import.meta.client) return [];
    try {
      const { captureFromList } = await import("~~/shared/vault");
      return captureFromList(items, folders);
    } catch {
      return [];
    }
  }

  /**
   * Bank ONE row, because its own button was pressed.
   *
   * Everything else here is the automatic path: debounced, deduped against a
   * fingerprint, and gated on a consent question because capture happens without
   * anyone asking for it. A press is none of those things — it is the answer to
   * that question, for that row, right now. So this sends immediately and skips the
   * fingerprint memo (the row may already be in it from an earlier automatic pass,
   * and the press must still visibly do something). It answers for that row ONLY —
   * see the note below the POST.
   *
   * It still goes through captureFromList, so the identity and worthiness rules in
   * shared/vault are the SAME ones the automatic path uses. Passing the whole list
   * alongside is what lets isVaultWorthy see that a row has children — a group is a
   * container, not gear, and one row on its own can't tell.
   *
   * Reports WHY it didn't work, not just that it didn't. The two failures need
   * different words — a row with no weight is something you can fix on the row, a
   * missing vault is something you fix by signing in — and a single boolean would
   * make the caller guess, which is how you end up telling someone to add a weight
   * to a row that already has one.
   */
  async function captureOne(
    item: Item,
    allItems: Item[],
    folders: Folder[],
    editToken: string,
  ): Promise<{ result: CaptureOneResult; landed: VaultGearKey[] }> {
    const nothing: VaultGearKey[] = [];
    if (!import.meta.client) return { result: "failed", landed: nothing };
    let caps: VaultCapture[];
    try {
      const { captureFromList } = await import("~~/shared/vault");
      // the folder list is passed so the row lands filed, not in a flat pile
      caps = captureFromList([item], folders);
    } catch {
      // chunk fetch failed (offline before the SW cached it)
      return { result: "failed", landed: nothing };
    }
    // a parent is a container, not gear; captureFromList can't see that from one item
    if (!caps.length || allItems.some((i) => i.parentId === item.id))
      return { result: "unworthy", landed: nothing };
    let landed: VaultGearKey[];
    let full = false;
    try {
      const res = await vaultFetch<{ keys?: VaultGearKey[]; full?: boolean }>(
        "/api/vault/capture",
        { method: "POST", body: { items: caps } },
      );
      landed = res?.keys ?? [];
      full = !!res?.full;
    } catch {
      return { result: "failed", landed: nothing };
    }
    // The press said "this gear is mine" and the vault either took it or didn't.
    // It DIDN'T when the row is gear you removed on /gear: capture never
    // resurrects a tombstone, so the write lands on a row that stays put away.
    //
    // Its OWN answer, not "failed" — the two need different words. A failure is
    // worth retrying and this is not: pressing again will do exactly as little,
    // for as long as the removal stands. And a FULL vault is not that either:
    // there is nothing in the removed list to find, so the same message would
    // have you looking forever.
    if (!landed.some(([k]) => k === caps[0]?.normKey))
      return { result: full ? "full" : "removed", landed: nothing };
    // The landed keys go back to the CALLER rather than into a shared cache. My
    // Gear has this gear now, which is what stops a duplicate of it further down
    // the same list from still offering to save it — and the caller is the open
    // list, whose answer dies with it, so a response that outlives the list (or
    // the account that sent it) writes into state that is already gone.
    // DELIBERATELY does not set the list-wide decision, tempting though it looks.
    // Pressing save on ONE row says "this piece of gear is mine". It says nothing
    // about the other forty, which on a list opened from someone else's edit link
    // are quite likely theirs — and "yes" here is the same flag captureNewList sets,
    // so the next keystroke would POST the whole list. That is the exact leak the
    // consent gate exists to stop. The question stays open; the prompt still comes.
    //
    // the automatic path's memo is now stale — it would otherwise treat the next
    // edit as "already stored" and skip a genuine change
    lastFingerprint = "";
    return { result: "saved", landed };
  }

  return { sync, buildCaptures, captureNewList, captureOne, bindFlushOnLeave };
}

/** Reset the capture memo — called when a device switches vaults, so
 *  the next vault doesn't inherit the previous one's "already sent". */
export function resetVaultCapture(): void {
  clearTimeout(timer);
  lastFingerprint = "";
  pending = null;
  // Nothing else to drop. What the vault HOLDS used to be cached app-wide here
  // too, and had to be cleared on the way out of an account or the next person
  // inherited it; it lives on the open list now (useGearList), which drops it
  // when the list closes and re-asks when the session changes.
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/**
 * Debounced, abortable autocomplete against your own gear. The same shape as
 * useCatalogSearch (results / search / clear) — the two are one scaffold now,
 * useDebouncedSearch — so the item input drives both from one keystroke with no
 * special-casing.
 *
 * Ranking happens on the server (shared/vault.ts), so nothing here needs the
 * trigram code — this composable is a fetch and a timer.
 */
export function useVaultSearch() {
  const { hasVault, vaultFetch } = useVaultAccess();
  // the timer / abort / stale-guard scaffold (and the 140ms) is useDebouncedSearch's,
  // shared with the catalog search — see its header
  return useDebouncedSearch<VaultEntry>(
    async (q, signal) => {
      const res = await vaultFetch<{ results: VaultEntry[] }>("/api/vault/search", {
        query: { q },
        signal,
      });
      return res.results || [];
    },
    {
      // With no vault there is nothing to search — skip the round trip entirely
      // rather than asking the server on every keystroke for a guaranteed [].
      ready: () => hasVault.value,
    },
  );
}
