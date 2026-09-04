import type { Ref } from "vue";

/**
 * What My Gear ALREADY holds — the set of identity keys, and nothing else.
 *
 * WHY THIS EXISTS. The row's "Save to My Gear" button is supposed to disappear
 * once the gear is banked, and for three attempts it decided that from a PROXY:
 * "will the automatic capture path bank this row, for this list, on this device?"
 * That is a different question, and it answers no in a pile of ordinary
 * situations where the gear has been in the vault for months — a list you built
 * on your phone and opened on your laptop (the per-list answer lives in
 * localStorage, so the laptop has never heard of it), a list you answered "no"
 * to, a row you unticked in the chooser, gear you added by hand on /gear. In
 * every one of them the button came back and offered to save what was saved.
 *
 * So the button now asks the vault. One small GET per editor session, one column
 * wide, folded into a Set; a row is covered when the vault genuinely has its
 * normKey, or when the automatic path is about to put it there.
 *
 * SINGLETON, deliberately — the same lesson useVaultAccess learned: a 150-row
 * list asks this per row, and a per-caller ref would mean 150 copies of one fact
 * and 150 fetches racing each other. State is built once, in a detached scope, so
 * the first row to mount can't take it down again when it unmounts.
 */

type KeyState = {
  keys: Ref<ReadonlySet<string>>;
  /** Whether `keys` is an ANSWER yet, or still the empty set it starts as.
   *  The distinction is the whole point: "the vault has nothing" and "we haven't
   *  asked" look identical in a Set, and treating the second as the first is
   *  exactly the flash PR #239 took out of the signed-in first paint. */
  known: Ref<boolean>;
};

let shared: KeyState | undefined;
let inFlight: Promise<void> | undefined;
// Bumped by every reset. A read that was already out when an account ended must
// not land afterwards and repopulate the set with the last person's gear — the
// exact leak resetVaultKeys exists to close, and the sign-out path makes it
// reachable (hasVault flips, the watcher clears the set, then the old request
// arrives). The epoch is what makes a stale answer recognisably stale.
let epoch = 0;

function build(): KeyState {
  // shallowRef: the set is replaced wholesale on every change, never mutated in
  // place, so there is nothing for deep reactivity to track
  return { keys: shallowRef<ReadonlySet<string>>(new Set()), known: ref(false) };
}

function state(): KeyState {
  // On the server there is no session to read and no fetch to make, so each call
  // builds its own inert pair rather than sharing one across requests.
  if (!import.meta.client) return build();
  if (shared) return shared;
  const scope = effectScope(true);
  // assigned BEFORE the watcher runs, so the load() its immediate tick fires
  // re-enters this function and finds the singleton rather than building a second
  shared = scope.run(build)!;
  scope.run(() => {
    const { hasVault, vaultKnown } = useVaultAccess();
    // ONE watcher for the whole app, in the scope that outlives every row. It
    // does the first fetch (immediate) and the re-ask when the session finally
    // answers — which for a signed-in visitor lands a beat after the first rows
    // have already mounted and decided what to render.
    watch([vaultKnown, hasVault], () => void load(), { immediate: true });
  });
  return shared;
}

/**
 * Fetch the keys, once.
 *
 * Gated on the session having ANSWERED. Signed out there is no vault and no
 * request to make — the answer is "nothing is banked", known immediately, which
 * is what keeps a visitor without an account off this endpoint entirely.
 *
 * A failed lookup (offline, rate-limited, a blip) settles as known-with-nothing
 * rather than retrying forever: that puts the button back exactly where it was
 * before this composable existed — offered on every worthy row — instead of
 * hiding a working affordance behind a request that may never land. The next
 * list opened calls this with `force` and tries again.
 */
async function load(force = false): Promise<void> {
  if (!import.meta.client) return;
  const s = state();
  const { hasVault, vaultKnown, vaultFetch } = useVaultAccess();
  if (!vaultKnown.value) return; // the session is still in flight; the watcher re-runs
  if (!hasVault.value) {
    s.keys.value = new Set();
    s.known.value = true;
    return;
  }
  // a read already out is the fresh one, forced or not — join it rather than
  // racing a second against it
  if (inFlight) return inFlight;
  if (s.known.value && !force) return;
  const mine = epoch;
  inFlight = (async () => {
    try {
      const res = await vaultFetch<{ keys: string[] }>("/api/vault/keys");
      if (mine !== epoch) return;
      s.keys.value = new Set(Array.isArray(res?.keys) ? res.keys : []);
    } catch {
      /* see above — an unanswerable question falls back to the old behaviour */
    }
    if (mine === epoch) s.known.value = true;
  })();
  try {
    await inFlight;
  } finally {
    inFlight = undefined;
  }
}

/**
 * Fold keys this device has just banked into the set, so the button stands down
 * without a second round trip.
 *
 * Only ever ADDS. These are the rows a capture just sent, which is the same set
 * the automatic path already claimed coverage for — so this can't make the button
 * lie about anything it wasn't already lying about, and it means banking a row by
 * hand also quiets a duplicate of that gear further down the list.
 */
export function noteVaultKeys(keys: string[]): void {
  if (!import.meta.client || !keys.length) return;
  const s = state();
  const next = new Set(s.keys.value);
  for (const k of keys) if (k) next.add(k);
  s.keys.value = next;
}

/** Drop the set on the way out of an account, so the next person to sign in on
 *  this device doesn't inherit a stranger's gear as "already yours". Paired with
 *  resetVaultCapture in useSession.forgetAccountMemos. */
export function resetVaultKeys(): void {
  if (!import.meta.client) return;
  epoch++; // disowns a read still in flight (see above)
  if (!shared) return;
  shared.keys.value = new Set();
  shared.known.value = false;
}

export function useVaultKeys() {
  // Building the singleton is what starts the first fetch, so the first row to
  // mount puts the answer on its way. Asking again while it is still unanswered
  // re-kicks it — the watcher only fires on a CHANGE, and a reset (signing out,
  // then in again on the same page) leaves nothing to change. `load` de-dupes, so
  // the other 149 rows of the list still join the one request.
  const s = state();
  if (!s.known.value) void load();
  return {
    vaultKeys: s.keys,
    vaultKeysKnown: s.known,
    /** Re-read from the server — for the points where the vault may have changed
     *  behind the editor's back (another tab, or an edit on /gear). */
    refreshVaultKeys: () => load(true),
  };
}
