// The vault's two client jobs: quietly remembering the gear you put in a list,
// and offering it back the next time you build one.

import type { Folder, Item } from "~~/shared/types";
import type { VaultCapture, VaultEntry } from "~~/shared/vault";

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

export type VaultDecision = "yes" | "no" | "ask";

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
  if (!editToken) return;
  try {
    localStorage.setItem(DECISION_KEY(editToken), decision);
  } catch {
    /* storage blocked — the choice holds for this session only */
  }
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
let pending: { items: unknown[]; fingerprint: string } | null = null;

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
export function useVaultCapture() {
  const { token, setToken, vaultFetch } = useVaultToken();

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
    opts: { editToken?: string; onAsk?: () => void } = {},
  ): void {
    if (!import.meta.client) return;
    void (async () => {
      let built: { caps: unknown[]; fingerprint: string } | null = null;
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
        if (decision === "ask") return opts.onAsk?.();
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
      const res = await vaultFetch<{ vaultToken?: string }>("/api/vault/capture", {
        method: "POST",
        body: { items: sending.items },
      });
      // first capture on this device — the server minted a vault and this is the
      // only time its token is ever sent to us
      if (res?.vaultToken) setToken(res.vaultToken);
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
   * The token goes in the BODY here, not a header — a beacon can't set one. The
   * capture endpoint accepts it there for exactly this reason; see suppliedToken()
   * in server/utils/vaultAuth.ts. A beacon that mints a vault can't tell us the new
   * token (nothing is listening by then), so that capture lands and the next edit
   * mints again — which is why the mint path is the debounced fetch above, and the
   * beacon is the last-resort backstop.
   */
  function flush(): void {
    if (!import.meta.client || !pending || !navigator.sendBeacon) return;
    const blob = new Blob(
      [JSON.stringify({ items: pending.items, ...(token.value ? { vaultToken: token.value } : {}) })],
      { type: "application/json" },
    );
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

  return { sync, buildCaptures, captureNewList, bindFlushOnLeave };
}

/** Reset the capture memo — called when a device switches vaults, so
 *  the next vault doesn't inherit the previous one's "already sent". */
export function resetVaultCapture(): void {
  clearTimeout(timer);
  lastFingerprint = "";
  pending = null;
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/**
 * Debounced, abortable autocomplete against your own gear. Mirrors
 * useCatalogSearch's shape (results / search / clear) so the item input drives
 * both from one keystroke with no special-casing.
 *
 * Ranking happens on the server (shared/vault.ts), so nothing here needs the
 * trigram code — this composable is a fetch and a timer.
 */
export function useVaultSearch() {
  const { hasVault, vaultFetch } = useVaultToken();
  const results = ref<VaultEntry[]>([]);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let lastQ = "";

  function clear() {
    clearTimeout(searchTimer);
    controller?.abort();
    results.value = [];
    lastQ = "";
  }

  function search(raw: string) {
    const q = raw.trim();
    clearTimeout(searchTimer);
    // With no vault there is nothing to search — skip the round trip entirely
    // rather than asking the server on every keystroke for a guaranteed [].
    if (q.length < 2 || !hasVault.value) {
      clear();
      return;
    }
    // 140ms matches the catalog input's debounce, so the two halves of the menu
    // settle together instead of the list reshuffling twice per keystroke.
    searchTimer = setTimeout(async () => {
      lastQ = q;
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await vaultFetch<{ results: VaultEntry[] }>("/api/vault/search", {
          query: { q },
          signal: controller.signal,
        });
        if (lastQ === q) results.value = res.results || [];
      } catch {
        // a newer keystroke aborted this, or we're offline — leave the previous
        // results alone rather than blanking the menu mid-type
      }
    }, 140);
  }

  return { results, search, clear };
}
