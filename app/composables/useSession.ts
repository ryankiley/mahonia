// Who's signed in, app-wide.
//
// Accounts exist for ONE reason — the vault, which has to follow a person across
// devices — so this composable is deliberately thin: an email or nothing. Lists
// are untouched by it and still need no login, and nothing here should grow into
// a general "user profile".
//
// Backed by useState so the value is shared across every component that asks for
// it (one fetch per page load, not one per caller) and survives SSR → hydration.


export interface SessionState {
  email: string | null;
  /** Optional and opt-in — the only part of an account anyone else ever sees.
   *  Null means this person's public lists carry no byline, which is the default. */
  displayName: string | null;
}

export function useSession() {
  const user = useState<SessionState | null>("session-user", () => null);
  // Distinguishes "not fetched yet" from "fetched, signed out" — without it the
  // vault page flashes its signed-out state before /api/auth/me answers.
  const loaded = useState<boolean>("session-loaded", () => false);
  const pending = useState<boolean>("session-pending", () => false);

  // Presence of the user, NOT of an email. An account created with a passkey has
  // no address until someone attaches one, so keying this off `email` would read
  // every one of them as signed out — and take the vault, capture and the byline
  // down with it. The account is the identity; the address is only the way back in.
  const signedIn = computed(() => user.value !== null);

  /** The readable companion flag the server sets alongside the HttpOnly session
   *  cookie (see SESSION_HINT_COOKIE). Not a credential — just "worth asking". */
  function hasSessionHint(): boolean {
    return import.meta.client && document.cookie.includes("mh_signed_in=1");
  }

  function clearSessionHint(): void {
    if (import.meta.client) document.cookie = "mh_signed_in=; Max-Age=0; path=/";
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
      user.value = null;
      loaded.value = true;
      return;
    }
    pending.value = true;
    try {
      const res = await $fetch<{
        user: { email: string; displayName: string | null } | null;
      }>("/api/auth/me");
      user.value = res.user
        ? {
            email: res.user.email,
            displayName: res.user.displayName ?? null,
          }
        : null;
      // A hint with no session behind it (expired, or signed out in another tab)
      // would otherwise keep costing a request on every page load — drop it.
      if (!res.user) clearSessionHint();
    } catch {
      // offline or a server blip — treat as signed out for rendering purposes,
      // but leave `loaded` false so the next call retries rather than caching a
      // wrong answer for the rest of the session
      user.value = null;
      pending.value = false;
      return;
    }
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

  async function signOut(): Promise<void> {
    try {
      await $fetch("/api/auth/signout", { method: "POST" });
    } finally {
      // clear locally too: the server drops both cookies, but doing it here means
      // the signed-out state holds even if that request never landed
      clearSessionHint();
      user.value = null;
      loaded.value = true;
    }
  }

  /** Patch the account's settings. Both fields are optional, so a caller changes
   *  one without restating the other; the shared state adopts whatever comes back. */
  async function saveProfile(patch: { displayName?: string }): Promise<boolean> {
    try {
      const res = await $fetch<{ ok: boolean; displayName: string | null }>(
        "/api/account/profile",
        { method: "POST", body: patch },
      );
      if (user.value)
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
    loaded,
    refresh,
    requestLink,
    signOut,
    hasSessionHint,
    saveProfile,
  };
}
