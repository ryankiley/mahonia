import type { ComputedRef } from "vue";

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
type VaultAccessRefs = { hasVault: ComputedRef<boolean>; vaultKnown: ComputedRef<boolean> };

// The two computeds, built ONCE per app rather than per caller. They wrap a
// singleton's state (useSession's useState), so every copy answered identically —
// and ItemRow and ItemInput each ask per row, which made a 150-row list hold ~300
// computeds for two facts. Created in a detached scope so the first caller's
// component unmounting can't take them down with it. Client-only: on the server
// useState is per request, and a module singleton there would hand request A's
// session to request B — so a server render builds its own pair, as before.
let shared: VaultAccessRefs | undefined;
function accessRefs(): VaultAccessRefs {
  if (import.meta.client && shared) return shared;
  const { signedIn, loaded } = useSession();
  const build = (): VaultAccessRefs => ({
    /** Is there a vault to talk to at all? Signed out, the answer is simply no. */
    hasVault: computed(() => signedIn.value),
    /**
     * Whether `hasVault` is an ANSWER yet, or still the `false` it holds by default
     * while /api/auth/me is in flight.
     *
     * The two are worlds apart for anything that reasons about what the vault
     * ALREADY contains. "Signed out" means nothing was ever captured; "not yet
     * known" means the page is a few hundred milliseconds early, and treating it as
     * signed out makes a signed-in visitor's first paint wrong on every load — see
     * the save button in ItemRow, which offered to save gear that was already saved.
     *
     * Costs nothing to wait for: with no session hint cookie, refresh() resolves to
     * "signed out" synchronously and without a request, so a visitor without an
     * account is settled before the first row renders. Only someone who plausibly
     * HAS a vault waits, and only for the round trip that decides it.
     */
    vaultKnown: computed(() => loaded.value),
  });
  if (!import.meta.client) return build();
  return (shared = effectScope(true).run(build)!);
}

export function useVaultAccess() {
  const { hasVault, vaultKnown } = accessRefs();

  /**
   * Call a vault endpoint. Same-origin, so the session cookie rides along; the
   * explicit `credentials` keeps that true if a call is ever made cross-origin by
   * accident rather than failing silently as an anonymous request.
   *
   * The options are spelled out rather than borrowed as `Parameters<typeof
   * $fetch>[1]`. That looked tidier and cost the whole file: taking Parameters of
   * a GENERIC function instantiates it at its constraint, which drags in Nuxt's
   * typed-route matcher — a recursive conditional type over every route in the
   * app — for a call that infers nothing from the route anyway (the return is
   * cast to `T`). It sat just under TypeScript's depth limit until a routes change
   * pushed it over, and then reported five TS2321s on this one line, in a file
   * nothing had touched. Casting the call itself keeps the matcher out of it.
   */
  type VaultFetchOptions = {
    method?: "GET" | "POST";
    body?: unknown;
    query?: Record<string, unknown>;
    signal?: AbortSignal;
  };
  async function vaultFetch<T>(url: string, opts: VaultFetchOptions = {}): Promise<T> {
    const call = $fetch as unknown as (u: string, o: unknown) => Promise<unknown>;
    return (await call(url, { ...opts, credentials: "same-origin" })) as T;
  }

  return { hasVault, vaultKnown, vaultFetch };
}
