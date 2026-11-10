// Who's signed in, app-wide.
//
// Accounts exist for ONE reason — the vault, which has to follow a person across
// devices — so this composable is deliberately thin: an email or nothing. Lists
// are untouched by it and still need no login, and nothing here should grow into
// a general "user profile".
//
// Backed by useState so the value is shared across every component that asks for
// it (one fetch per page load, not one per caller) and survives SSR → hydration.

import { SESSION_HINT_COOKIE, SESSION_OWNER_COOKIE } from "~~/shared/session";
import { sessionCacheOwner } from "../utils/sessionOwner";

interface SessionState {
  /** The session's owner marker (shared/session.ts): which account's browser-local
   *  caches are this one's. A string the server derives, never the account's id. */
  owner: string;
  email: string | null;
  /** Optional and opt-in — the only part of an account anyone else ever sees.
   *  Null means this person's public lists carry no byline, which is the default. */
  displayName: string | null;
  /** Whether the lists this browser made may be attached to the account without
   *  asking: true for a sign-in made here, false for one only confirmed here until
   *  the person says yes (allowListSweep). The server's answer, kept on the session. */
  sweep: boolean;
  /** Which account this is, the same across its sessions (see sessionAccount). */
  account: string;
}

/** What this tab knows of the session. "unresolved" means not asked yet, or the last
 *  ask failed, and is a different answer from signed out: without it the vault page
 *  flashes its signed-out state before /api/auth/me answers, and a failed re-read tells
 *  the switcher to throw the account's cached lists away. A user only exists inside
 *  "signedIn", so there is no such thing as a user nobody has resolved. */
type SessionAnswer =
  | { state: "unresolved" }
  | { state: "signedOut" }
  | { state: "signedIn"; user: SessionState };

// The ask in flight, and the one forced re-read waiting behind it. Module-level,
// like the state they guard is app-wide: every caller shares the one request.
let asking: Promise<void> | null = null;
let again: Promise<void> | null = null;
// How many asks have started, and how many had when a re-read was last forced:
// a forced re-read is owed an ask that started AFTER it was called for, and no
// more than that (see refresh).
let asks = 0;
let forcedAt = 0;

/** How long /api/auth/me may take. $fetch has no timeout of its own, and a forced
 *  re-read now waits for the ask in front of it: a socket that never answers (a
 *  captive portal, a dead radio) would hold "Signing you in…" on screen until the
 *  browser gave up, minutes later. Generous, because a cold function and a cold
 *  database can both be in front of the answer; past it the ask reads as failed,
 *  which the re-ask already retries. */
const ASK_TIMEOUT_MS = 10_000;

/**
 * Wait for any session check already out. For the three moments that change WHO
 * is signed in: redeeming a sign-in link, finishing a passkey ceremony, signing out.
 *
 * WHY THEY TAKE TURNS. Once a day the server answers a session check by renewing
 * the session, and re-sends its cookies to do it (resolveSession, on the server).
 * A response sets cookies whenever it lands. So with a check still out, a sign-in
 * sent beside it raced it: when the check's answer came back second, it put the
 * PREVIOUS session's cookies back over the new one's, and a person who had just
 * signed in to another account was in the old one again with nothing to say so.
 * (Signed out, the old cookies came back too, pointing at a session that was gone.)
 * The page's own check starts as the page loads, which is exactly when a sign-in
 * link's page sends the link, so the two were out together by construction.
 *
 * Never rejects, and never waits long: the ask is bounded (ASK_TIMEOUT_MS), and a
 * failed one is no reason to refuse to sign someone in.
 */
export function sessionSettled(): Promise<void> {
  const out = again ?? asking;
  const done = () => {};
  return out ? out.then(done, done) : Promise.resolve();
}

/** The session as three answers, not two — see `presence` below. */
export type Presence = "signedIn" | "signedOut" | "presumed";

export function useSession() {
  const session = useState<SessionAnswer>("session", () => ({ state: "unresolved" }));
  const user = computed(() => (session.value.state === "signedIn" ? session.value.user : null));
  const loaded = computed(() => session.value.state !== "unresolved");
  // the request in flight, which de-dupes callers; a re-read happens under any answer
  const pending = useState<boolean>("session-pending", () => false);
  // the last ask failed (offline, a server blip): what useSessionReask waits on, so it
  // asks again only after a real failure, never merely because nothing has asked yet
  const askFailed = useState<boolean>("session-ask-failed", () => false);

  // Presence of the user, NOT of an email. An account created with a passkey has
  // no address until someone attaches one, so keying this off `email` would read
  // every one of them as signed out — and take the vault, capture and the byline
  // down with it. The account is the identity; the address is only the way back in.
  const signedIn = computed(() => session.value.state === "signedIn");

  /**
   * The session as the three-way answer the surfaces that cannot wait for
   * /api/auth/me actually need — or that, offline, will never get one: "signedIn"
   * and "signedOut" once the server has resolved it, "presumed" while it hasn't but
   * the hint cookie says there is an account behind this browser. The ONE
   * definition of "offline with a hint": the switcher's cache, the account menu and
   * the vault gate each used to spell it from signedIn, loaded and the cookie in
   * their own words. The cookie read is not reactive; the answer moves when
   * `session` does, which is every moment the cookie itself is changed here.
   */
  const presence = computed<Presence>(() =>
    session.value.state !== "unresolved" ? session.value.state : hasSessionHint() ? "presumed" : "signedOut",
  );

  /** The readable companion flag the server sets alongside the HttpOnly session
   *  cookie (see SESSION_HINT_COOKIE). Not a credential — just "worth asking". */
  function hasSessionHint(): boolean {
    return readCookie(SESSION_HINT_COOKIE) === "1";
  }

  function clearSessionHint(): void {
    if (!import.meta.client) return;
    document.cookie = `${SESSION_HINT_COOKIE}=; Max-Age=0; path=/`;
    document.cookie = `${SESSION_OWNER_COOKIE}=; Max-Age=0; path=/`;
  }

  /** Fetch the current session. Idempotent and de-duped: several components
   *  calling it on the same page produce one request. `force` re-reads after a
   *  sign-in/out has changed the answer.
   *
   *  With no hint cookie there is nothing to ask about, so this resolves to
   *  "signed out" WITHOUT a request — which is the whole point of the hint, and
   *  what keeps the prerendered editor free of a round-trip for the visitors (most
   *  of them) who have no account.
   *
   *  A FORCED re-read that finds one already out waits for it and then asks again,
   *  once however many callers force it. It used to return at once, having asked
   *  nothing: the caller that had just signed in carried on with the answer to a
   *  question put before the sign-in. */
  function refresh(force = false): Promise<void> {
    if (!import.meta.client) return Promise.resolve();
    if (asking) {
      if (!force) return Promise.resolve();
      forcedAt = asks;
      // If the ask in front turned out stale it has already asked again by itself;
      // where that second ask started after this call, it IS the re-read, and a
      // third request would only keep "Signing you in…" up for another round trip.
      const run = () => {
        again = null;
        return asks > forcedAt ? undefined : refresh(true);
      };
      // on either outcome: an ask cannot reject as written, and if one ever did,
      // a re-read left hanging off it would fail every forced caller from then on
      return (again ??= asking.then(run, run));
    }
    if (!force && (loaded.value || pending.value)) return Promise.resolve();
    if (!hasSessionHint()) {
      settleSignedOut();
      return Promise.resolve();
    }
    asking = ask().finally(() => (asking = null));
    return asking;
  }

  /** No session behind this browser: let go of what was kept for the account. */
  function settleSignedOut(owner?: string | null): void {
    forgetAccountMemos(owner);
    clearSessionHint();
    session.value = { state: "signedOut" };
  }

  /** `kept`: whose caches this tab holds, when the caller already knows. A stale
   *  answer's re-ask passes it on (see below). */
  async function ask(kept?: string | null): Promise<void> {
    asks++;
    pending.value = true;
    // WHICH SESSION THE QUESTION IS ABOUT, read before the wait and not after. The
    // cookie can change while the request is out (a sign-in finishing in this tab,
    // a sign-out in another), and the answer is then about a session this browser
    // no longer holds. Read afterwards, the new session's owner stood in for "who
    // was here before", the stale answer disagreed with it, and the memos just
    // written for the NEW session were dropped as the old one's — its hint cookie
    // with them, when the stale answer was "no user".
    const askedAs = sessionCacheOwner();
    const previousOwner = kept !== undefined ? kept : (user.value?.owner ?? askedAs);
    try {
      const res = await $fetch<{ user: SessionState | null }>("/api/auth/me", {
        signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
      });
      const holds = sessionCacheOwner();
      // An answer about a session that is no longer this browser's: the marker
      // changed while it was out and the answer isn't about the new one, or it
      // names a user and the hint that there is one has gone (signed out in another
      // tab; the only sign of it for a session too old to have a marker).
      const stale =
        (holds !== askedAs && (res.user?.owner ?? null) !== holds) || (res.user !== null && !hasSessionHint());
      if (stale) {
        // Ask about the session that IS here, or settle signed out if there is
        // none. WITH the owner this ask started from: the re-ask begins with the new
        // session's marker already in the cookie, and working "who was here before"
        // out again from that would find nobody. The previous account's memos, and
        // its lists still in the switcher's memory, would then outlive it under the
        // next person's session.
        if (hasSessionHint()) return await ask(previousOwner);
        return settleSignedOut(previousOwner);
      }
      const nextUser = res.user;
      // A different owner than the one this tab's caches were kept for — another
      // account signed in here, or this one signed in afresh — drops those caches
      // before the new answer is on screen. Only ever the former owner's keys.
      if (previousOwner !== null && previousOwner !== nextUser?.owner) {
        forgetAccountMemos(previousOwner);
      }
      session.value = nextUser ? { state: "signedIn", user: nextUser } : { state: "signedOut" };
      if (nextUser) rememberSessionAccount(nextUser.owner, nextUser.account);
      // A hint with no session behind it (expired, or signed out in another tab)
      // would otherwise keep costing a request on every page load — drop it. And
      // drop what this device kept FOR that account with it: a session ending here
      // without a sign-out — expiry, "sign out everywhere" run elsewhere, the account
      // deleted — was the one way out that reached none of the memos, so the
      // account's cached lists stood in the switcher until the menu opened, and its
      // opens ledger steered the bare address into its lists for whoever signed in
      // on this browser next.
      if (!res.user) {
        clearSessionHint();
      }
      askFailed.value = false;
    } catch {
      // offline or a server blip — no user for rendering purposes, but unresolved,
      // so the next call retries rather than caching a wrong answer for the rest of the
      // session. SET unresolved, not merely left: a forced re-read (after a sign-in, say)
      // arrives already resolved from the last success, and a failure then read as a
      // RESOLVED signed-out — the reading that tells the switcher to throw the account's
      // cached lists away.
      session.value = { state: "unresolved" };
      askFailed.value = true;
    } finally {
      pending.value = false;
    }
  }

  /**
   * Ask for a sign-in link.
   *
   * The endpoint's answer never varies with whether the address is KNOWN, so
   * there's nothing about the account to branch on. It does distinguish the two
   * failures a person can act on differently, neither of which says anything about
   * the address: 503 (this deploy can't send mail at all) and everything else
   * (offline, rate-limited — worth retrying).
   */
  async function requestLink(email: string): Promise<"sent" | "unavailable" | "error"> {
    try {
      await $fetch("/api/auth/request", { method: "POST", body: { email } });
      return "sent";
    } catch (e) {
      return statusOf(e) === 503 ? "unavailable" : "error";
    }
  }

  /** Drop the per-account memos this device keeps — the vault's "already
   *  sent", the registry's "already claimed", the account disc's letter, My Gear's
   *  copy and the copies of lists opened through the account — so the
   *  next person to sign in here starts clean rather than inheriting them. Every way
   *  out of an account runs it: signOut below does so itself; the delete-account and
   *  sign-out-everywhere paths (which end the session server-side, then re-read it)
   *  call it directly. A one-line seam, on purpose — this composable stays thin. */
  function forgetAccountMemos(owner = user.value?.owner ?? sessionCacheOwner()): void {
    resetVaultCapture();
    useClaimedLists().resetClaimMark(owner);
    forgetAccountInitial();
    // everything keyed to the account in localStorage, by the one list of it
    forgetOwned(owner);
    // The claimed opens' on-device copies, which are the account's too. Only where
    // there was an account: a visitor who never had one runs this on every load,
    // and has no business opening IndexedDB to find nothing.
    if (owner) void useLocalListStore().delClaimed();
  }

  async function signOut(): Promise<void> {
    await sessionSettled(); // or a check's late answer hands the cookies back
    const owner = user.value?.owner ?? sessionCacheOwner();
    try {
      await $fetch("/api/auth/signout", { method: "POST" });
    } finally {
      // clear locally too: the server drops both cookies, but doing it here means
      // the signed-out state holds even if that request never landed
      forgetAccountMemos(owner);
      clearSessionHint();
      session.value = { state: "signedOut" };
    }
  }

  /** The person's yes to "add this browser's lists to my account", for a sign-in
   *  that didn't bring them (see `sweep`). The session plugin watches the flag, so
   *  the sweep itself follows from the answer landing here. */
  async function allowListSweep(): Promise<boolean> {
    try {
      await $fetch("/api/auth/sweep", { method: "POST" });
    } catch {
      return false;
    }
    if (session.value.state === "signedIn")
      session.value = { state: "signedIn", user: { ...session.value.user, sweep: true } };
    return true;
  }

  /** Patch the account's one setting (the display name); the shared state adopts
   *  whatever comes back. */
  async function saveProfile(patch: { displayName?: string }): Promise<boolean> {
    try {
      const res = await $fetch<{ ok: boolean; displayName: string | null }>(
        "/api/account/profile",
        { method: "POST", body: patch },
      );
      if (session.value.state === "signedIn")
        session.value = {
          state: "signedIn",
          user: { ...session.value.user, displayName: res.displayName },
        };
      return res.ok;
    } catch {
      return false;
    }
  }


  return {
    user,
    signedIn,
    presence,
    loaded,
    /** /api/auth/me is in flight: "presumed" is still a question, not the offline
     *  answer it settles into when the ask fails. */
    pending: readonly(pending),
    refresh,
    requestLink,
    signOut,
    allowListSweep,
    forgetAccountMemos,
    hasSessionHint,
    saveProfile,
  };
}

/** How often a session that couldn't be asked is asked again. */
const REASK_MS = 30_000;

/**
 * Ask for the session again while it couldn't be answered: offline with an account,
 * /api/auth/me failed, the session stays "presumed", and nothing asked again until a
 * reload. Every surface that waits on the answer (My Gear, the account page and dialog,
 * the switcher's account rows, the account menu) reacts to `presence`, so this asks
 * once for all of them, from the session plugin.
 *
 * Three triggers, because the browser's "online" event is the least reliable: navigator
 * .onLine stays true through a dead connection, a captive portal or a server blip, so it
 * may never fire. Coming back to the tab or app asks too, and so does a slow clock while
 * the answer is missing; never from a hidden tab, which coming back covers.
 */
export function useSessionReask(): void {
  if (!import.meta.client) return;
  const { presence, pending, refresh } = useSession();
  const askFailed = useState<boolean>("session-ask-failed", () => false);
  const missing = computed(() => presence.value === "presumed" && !pending.value && askFailed.value);
  const reask = () => {
    if (missing.value && document.visibilityState === "visible") void refresh();
  };
  window.addEventListener("online", reask);
  document.addEventListener("visibilitychange", reask);
  let tick: ReturnType<typeof setInterval> | undefined;
  watch(
    missing,
    (now) => {
      clearInterval(tick);
      tick = now ? setInterval(reask, REASK_MS) : undefined;
    },
    { immediate: true },
  );
  // the plugin's lives as long as the app; a test's goes with its component
  if (getCurrentScope()) {
    onScopeDispose(() => {
      window.removeEventListener("online", reask);
      document.removeEventListener("visibilitychange", reask);
      clearInterval(tick);
    });
  }
}
