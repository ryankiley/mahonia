// Who's signed in, app-wide.
//
// Accounts exist for ONE reason — the vault, which has to follow a person across
// devices — so this composable is deliberately thin: an email or nothing. Lists
// are untouched by it and still need no login, and nothing here should grow into
// a general "user profile".
//
// Backed by useState so the value is shared across every component that asks for
// it (one fetch per page load, not one per caller) and survives SSR → hydration.


interface SessionState {
  email: string | null;
  /** Optional and opt-in — the only part of an account anyone else ever sees.
   *  Null means this person's public lists carry no byline, which is the default. */
  displayName: string | null;
}

/** The session as three answers, not two — see `presence` below. */
export type Presence = "signedIn" | "signedOut" | "presumed";

export function useSession() {
  const user = useState<SessionState | null>("session-user", () => null);
  // Distinguishes "not fetched yet" from "fetched, signed out" — without it the
  // vault page flashes its signed-out state before /api/auth/me answers.
  const loaded = useState<boolean>("session-loaded", () => false);
  const pending = useState<boolean>("session-pending", () => false);
  // A session can change while /api/auth/me is in flight: sign-out must not be
  // undone by an old "signed in" response, and a passkey sign-in's forced read
  // must not be ignored behind an older "signed out" one. The newest intent owns
  // state; older requests are allowed to finish but are no longer allowed to write.
  const refreshGeneration = useState<number>("session-refresh-generation", () => 0);
  // The identity behind the session, not just whether one exists. A → B keeps
  // `signedIn` true, so account-bound callers need a separate reactive lifetime
  // to discard A's in-flight vault/list work before B's `/api/auth/me` response
  // arrives. It advances at every forced re-read (the cookie may have changed),
  // sign-out, and an identity change discovered by an ordinary read.
  const accountGeneration = useState<number>("session-account-generation", () => 0);

  // Presence of the user, NOT of an email. An account created with a passkey has
  // no address until someone attaches one, so keying this off `email` would read
  // every one of them as signed out — and take the vault, capture and the byline
  // down with it. The account is the identity; the address is only the way back in.
  const signedIn = computed(() => user.value !== null);

  /**
   * The session as the three-way answer the surfaces that cannot wait for
   * /api/auth/me actually need — or that, offline, will never get one: "signedIn"
   * and "signedOut" once the server has resolved it, "presumed" while it hasn't but
   * the hint cookie says there is an account behind this browser. The ONE
   * definition of "offline with a hint": the switcher's cache, the account menu and
   * the vault gate each used to spell it from signedIn, loaded and the cookie in
   * their own words. The cookie read is not reactive; the answer moves when
   * `loaded` or `user` do, which is every moment the cookie itself is changed here.
   */
  const presence = computed<Presence>(() =>
    loaded.value ? (user.value ? "signedIn" : "signedOut") : hasSessionHint() ? "presumed" : "signedOut",
  );

  /** The readable companion flag the server sets alongside the HttpOnly session
   *  cookie (see SESSION_HINT_COOKIE). Not a credential — just "worth asking". */
  function hasSessionHint(): boolean {
    return import.meta.client && document.cookie.includes("mh_signed_in=1");
  }

  function clearSessionHint(): void {
    if (import.meta.client) document.cookie = "mh_signed_in=; Max-Age=0; path=/";
  }

  /**
   * Make the current account unknowable immediately. This runs BEFORE a forced
   * re-read, rather than after it identifies the next user: a stale request can
   * otherwise finish in the gap while `signedIn` remains true for both accounts.
   */
  function invalidateAccountContext(): void {
    accountGeneration.value++;
    // Do not render A's identity while the cookie is being re-read for B. `loaded`
    // stays false until the request settles, so account surfaces show their normal
    // resolving state instead of a signed-out conclusion.
    user.value = null;
    loaded.value = false;
    // A list token is device-local, but its capture consent is a judgement about
    // this account's vault. Do not let a stored A decision be read during the
    // interval before the cookie is confirmed as B.
    setVaultConsentScope(null, false);
    resetVaultCapture();
    useClaimedLists().resetClaimMark();
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
    // A normal caller can share an active read. A forced read means the cookie just
    // changed (after sign-in/out), so it deliberately supersedes that active read.
    if (pending.value && !force) return;
    if (loaded.value && !force) return;
    const priorIdentity = user.value?.email ?? null;
    if (force) invalidateAccountContext();
    // On a cold read the previous account is unknown too. Retire legacy/device
    // consent before any account-bound component can interpret it as permission.
    if (!force && !loaded.value) setVaultConsentScope(null, false);
    const mine = ++refreshGeneration.value;
    if (!hasSessionHint()) {
      if (!force && priorIdentity !== null) invalidateAccountContext();
      user.value = null;
      loaded.value = true;
      pending.value = false;
      setVaultConsentScope(null, true);
      return;
    }
    pending.value = true;
    try {
      const res = await $fetch<{
        user: { email: string; displayName: string | null } | null;
      }>("/api/auth/me");
      if (mine !== refreshGeneration.value) return;
      // A non-forced refresh can still discover that another tab replaced the
      // session. It did not have an advance at request start, so establish one
      // before handing the newly identified account to the rest of the app.
      const nextIdentity = res.user?.email ?? null;
      if (!force && nextIdentity !== priorIdentity) invalidateAccountContext();
      // Only this freshly resolved identity may read/write per-list vault
      // consent. Existing unscoped values are intentionally ignored rather than
      // guessed at: the browser may have belonged to someone else.
      setVaultConsentScope(res.user?.email ?? null, true);
      user.value = res.user
        ? {
            email: res.user.email,
            displayName: res.user.displayName ?? null,
          }
        : null;
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
        // The transition above invalidated a prior account. Even on a first
        // resolved signed-out read, drop any device cache that a past session
        // might have left behind.
        forgetAccountMemos();
      }
    } catch {
      if (mine !== refreshGeneration.value) return;
      // offline or a server blip — treat as signed out for rendering purposes,
      // but leave `loaded` false so the next call retries rather than caching a
      // wrong answer for the rest of the session. SET false, not merely left: a
      // forced re-read (after a sign-in, say) arrives with `loaded` already true
      // from the last success, and a failure then read as a RESOLVED signed-out —
      // the reading that tells the switcher to throw the account's cached lists away.
      user.value = null;
      loaded.value = false;
      pending.value = false;
      setVaultConsentScope(null, false);
      return;
    }
    if (mine !== refreshGeneration.value) return;
    loaded.value = true;
    pending.value = false;
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
      return (e as { statusCode?: number })?.statusCode === 503 ? "unavailable" : "error";
    }
  }

  /** Drop the two per-account memos this device keeps — the vault's "already sent"
   *  and the registry's "already claimed" — so the next person to sign in here
   *  starts clean rather than inheriting them. Every way out of an account runs
   *  it: signOut below does so itself; the delete-account and sign-out-everywhere
   *  paths (which end the session server-side, then re-read it) call it directly.
   *  A one-line seam, on purpose — this composable stays thin. */
  function forgetAccountMemos(): void {
    resetVaultCapture();
    useClaimedLists().resetClaimMark();
  }

  async function signOut(): Promise<void> {
    // Make any read that was sent under this session stale before the network
    // round-trip. Otherwise a slow /api/auth/me can put its user back after the
    // local sign-out below.
    invalidateAccountContext();
    const mine = ++refreshGeneration.value;
    pending.value = false;
    try {
      await $fetch("/api/auth/signout", { method: "POST" });
    } finally {
      // A newer successful sign-in took ownership while this request was pending.
      if (mine !== refreshGeneration.value) return;
      // clear locally too: the server drops both cookies, but doing it here means
      // the signed-out state holds even if that request never landed
      clearSessionHint();
      user.value = null;
      loaded.value = true;
      setVaultConsentScope(null, true);
    }
  }

  /** Patch the account's one setting (the display name); the shared state adopts
   *  whatever comes back. */
  async function saveProfile(patch: { displayName?: string }): Promise<boolean> {
    const mine = accountGeneration.value;
    try {
      const res = await $fetch<{ ok: boolean; displayName: string | null }>(
        "/api/account/profile",
        { method: "POST", body: patch },
      );
      // The server may have accepted a request sent just before sign-out, but its
      // profile response belongs to that account — never paint it onto whoever
      // signed in while it was in flight.
      if (mine === accountGeneration.value && user.value)
        user.value = {
          ...user.value,
          displayName: res.displayName,
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
    accountGeneration,
    refresh,
    requestLink,
    signOut,
    forgetAccountMemos,
    hasSessionHint,
    saveProfile,
  };
}
