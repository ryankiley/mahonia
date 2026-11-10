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
   *  of them) who have no account. */
  async function refresh(force = false): Promise<void> {
    if (!import.meta.client) return;
    if (pending.value) return;
    if (loaded.value && !force) return;
    if (!hasSessionHint()) {
      forgetAccountMemos();
      clearSessionHint();
      session.value = { state: "signedOut" };
      return;
    }
    pending.value = true;
    try {
      const res = await $fetch<{ user: SessionState | null }>("/api/auth/me");
      const previousOwner = user.value?.owner ?? sessionCacheOwner();
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
    forgetGearCopy(owner);
    // The claimed opens' on-device copies, which are the account's too, and the
    // note of which account that was. Only where there was an account: a visitor
    // who never had one runs this on every load, and has no business opening
    // IndexedDB to find nothing.
    if (owner) {
      forgetSessionAccount(owner);
      void useLocalListStore().delClaimed();
    }
  }

  async function signOut(): Promise<void> {
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
