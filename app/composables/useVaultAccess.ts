/**
 * How a client reaches its vault.
 *
 * The replacement for `useVaultToken`, and much smaller than it — because the
 * question it answers is now "are you signed in?" rather than "which unguessable
 * string does this browser happen to hold?".
 *
 * Nothing is stored client-side. The session cookie is HttpOnly and travels on its
 * own for same-origin requests, so there is no token to keep in localStorage, no
 * cross-tab sync to keep two tabs agreeing, and no transfer link to move a vault
 * between devices — signing in on the second device IS the transfer.
 *
 * `vaultFetch` exists for the same reason its predecessor did: so a call site
 * can't forget the credential. It no longer attaches a header, but it does keep
 * every vault call going through one function, which is what made the missing
 * Authorization headers on remove/restore/price findable last time.
 */
export function useVaultAccess() {
  const { signedIn } = useSession();

  /** Is there a vault to talk to at all? Signed out, the answer is simply no. */
  const hasVault = computed(() => signedIn.value);

  /**
   * Call a vault endpoint. Same-origin, so the session cookie rides along; the
   * explicit `credentials` keeps that true if a call is ever made cross-origin by
   * accident rather than failing silently as an anonymous request.
   */
  async function vaultFetch<T>(url: string, opts: Parameters<typeof $fetch>[1] = {}): Promise<T> {
    return (await $fetch(url, { ...opts, credentials: "same-origin" })) as T;
  }

  return { hasVault, vaultFetch };
}
