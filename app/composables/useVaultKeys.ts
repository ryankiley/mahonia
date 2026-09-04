import type { Ref } from "vue";
import type { VaultGearKey } from "~~/shared/vault";

/**
 * What My Gear ALREADY holds — the gear's identity keys, and the one number that
 * can still be pushed into one.
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
 * So the button now asks the vault. One small GET per signed-in session, folded
 * into a Map; a row is covered when the vault genuinely has its normKey with
 * nothing left to push, or when the automatic path is about to put it there.
 *
 * The value is `weightMg`, or null when that row's weight is PINNED. Membership
 * alone was not enough: capture takes the incoming weight, so a row whose weight
 * you have just corrected is still worth pressing, and a bare Set made the button
 * vanish on first bank and never return (see coverage in ItemRow).
 *
 * SINGLETON, deliberately — the same lesson useVaultAccess learned: a 150-row
 * list asks this per row, and a per-caller ref would mean 150 copies of one fact
 * and 150 fetches racing each other. State is built once, in a detached scope, so
 * the first row to mount can't take it down again when it unmounts.
 */

/** A vault row as this cache holds it: its weight in mg, or null when the weight
 *  is pinned and no capture may change it. */
export type VaultGear = ReadonlyMap<string, number | null>;

type KeyState = {
  gear: Ref<VaultGear>;
  /** Whether `gear` is an ANSWER yet, or still the empty Map it starts as.
   *  The distinction is the whole point: "the vault has nothing" and "we haven't
   *  asked" look identical in a Map, and treating the second as the first is
   *  exactly the flash PR #239 took out of the signed-in first paint. */
  known: Ref<boolean>;
};

let shared: KeyState | undefined;
let inFlight: Promise<void> | undefined;
// Monotonic per read, so a slower older response cannot land on top of a newer one.
let issued = 0;
let waiting: ReturnType<typeof setTimeout> | undefined;
// The `banked` maps of every read currently out (see load) — noteVaultKeys writes
// through to them so a read cannot land and drop a capture that beat it home.
const banking = new Set<Map<string, number | null>>();
// Bumped whenever the answer this cache holds stops being about the current
// account — a sign-out, and every other session change. A read or a capture that
// was already out then lands into a vault that is no longer the one it asked
// about, and must write nothing; the epoch is what makes such an answer
// recognisably stale. Handed to callers by vaultKeysEpoch() so a capture can
// carry it across its own POST.
let epoch = 0;

function build(): KeyState {
  // shallowRef: the Map is replaced wholesale on every change, never mutated in
  // place, so there is nothing for deep reactivity to track
  return { gear: shallowRef<VaultGear>(new Map()), known: ref(false) };
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
    // ONE watcher for the whole app, in the scope that outlives every row.
    //
    // It INVALIDATES before loading, and that is the whole correctness of the
    // thing: every edge it fires on is a change of session, and an answer about
    // the last session is not an answer about this one. Without the invalidation
    // the signed-out branch below (which settles `known` with an empty Map) held
    // for the account signed in afterwards — so signing in from the editor, which
    // never navigates and so never reopens a list, left the cache saying "your
    // vault is empty" for the rest of the page. Every row then fell back to the
    // old per-list proxy and offered to save gear banked months ago: the exact
    // bug this composable exists to remove, reinstated by the most ordinary way
    // anyone reaches the feature.
    watch([vaultKnown, hasVault], () => {
      invalidate();
      void load();
    }, { immediate: true });
  });
  return shared;
}

/** Forget the answer (and disown any read still out) without touching whether
 *  anyone is signed in — the half of a reset that a session CHANGE also needs. */
function invalidate(): void {
  epoch++;
  inFlight = undefined;
  banking.clear(); // nothing in flight speaks for the new session
  // Release the give-up timer too. It captured the OLD epoch, so leaving it
  // pending both disowns its own bound (it will fire, fail the epoch check and
  // settle nothing) and blocks the re-arm below, which refuses to stack a second
  // timer — between them the wait became unbounded again, which is the failure
  // SESSION_WAIT_MS exists to prevent.
  clearTimeout(waiting);
  waiting = undefined;
  if (!shared) return;
  shared.gear.value = new Map();
  shared.known.value = false;
}

/** How long to wait on a session that hasn't answered before giving up on it.
 *
 *  `useSession.refresh()` deliberately leaves `loaded` false when /api/auth/me
 *  fails, so a later call can retry — but the only caller is the one-shot boot
 *  plugin, so offline (or a 429, or a blip) means it never answers at all. The
 *  row holds its save button back while this cache is unanswered, so without a
 *  bound that is a button hidden for the whole session on every row of every
 *  list, with no way to get it back. Giving up settles as known-with-nothing,
 *  which puts the row exactly where it stood before this cache existed. */
const SESSION_WAIT_MS = 6_000;
/** ...and the same bound on the read itself, for the same reason. */
const READ_TIMEOUT_MS = 6_000;

/**
 * Fetch the vault's gear, once.
 *
 * Gated on the session having ANSWERED. Signed out there is no vault and no
 * request to make — the answer is "nothing is banked", known immediately, which
 * is what keeps a visitor without an account off this endpoint entirely.
 *
 * A failed lookup (offline, rate-limited, a blip) settles as known-with-nothing
 * rather than retrying forever: that puts the button back exactly where it was
 * before this composable existed — offered on every worthy row — instead of
 * hiding a working affordance behind a request that may never land. The next
 * session change, or the next list opened, tries again.
 *
 * Never rejects. Callers treat this as best-effort and `void` it, and a floating
 * rejection out of the editor's list-open path is an unhandled rejection in the
 * console (and a crash in a test runner that fails on them).
 */
async function load(force = false): Promise<void> {
  if (!import.meta.client) return;
  const s = state();
  const { hasVault, vaultKnown, vaultFetch } = useVaultAccess();
  if (!vaultKnown.value) {
    // the watcher re-runs when the session answers; this only covers its NOT
    // answering, and re-arming would push the deadline out forever
    if (waiting === undefined) {
      const mine = epoch;
      waiting = setTimeout(() => {
        waiting = undefined;
        if (mine === epoch && !s.known.value) s.known.value = true;
      }, SESSION_WAIT_MS);
    }
    return;
  }
  clearTimeout(waiting);
  waiting = undefined;
  if (!hasVault.value) {
    s.gear.value = new Map();
    s.known.value = true;
    return;
  }
  // A forced read is asking for state that may have changed since the read
  // already out was issued, so it must not settle for that one; an unforced
  // caller joins it rather than racing a second against it.
  if (!force && inFlight) return inFlight;
  if (s.known.value && !force) return;
  const mine = epoch;
  // keys this device banks while this read is out — see the merge below
  const banked = new Map<string, number | null>();
  banking.add(banked);
  const seq = ++issued;
  const run = (async () => {
    try {
      const res = await Promise.race([
        vaultFetch<{ keys: VaultGearKey[] }>("/api/vault/keys"),
        // The row holds its save button back until this settles, and $fetch has
        // no timeout of its own — so a socket that never answers (a captive
        // portal, a dead radio) hid the button on every row of every list until
        // the browser gave up minutes later. The session wait is bounded for the
        // same reason; so is this.
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("vault keys timed out")), READ_TIMEOUT_MS),
        ),
      ]);
      // NEWEST answer wins. A forced read deliberately races rather than joining
      // one already out (it exists because the vault may have changed since that
      // one was issued) — so without a sequence the slower, OLDER response landed
      // last and reverted the fresher one.
      if (mine !== epoch || seq !== issued) return;
      // The read REPLACES — it is the server's current truth, and gear you
      // removed on /gear has to be able to leave. Carrying the old Map forward
      // instead (a plain union) made every key immortal: a removal was answered
      // correctly by the server and then re-added from the stale value, so the
      // save button stayed hidden on gear the vault no longer held, for the life
      // of the page, with no way to reach it.
      //
      // What DOES survive is the narrow thing the union was reaching for: a
      // capture this device landed WHILE this read was out. The server built its
      // answer before that write, so it cannot mention it, and dropping it put
      // the button back on gear banked seconds earlier.
      const next = new Map(Array.isArray(res?.keys) ? res.keys : []);
      for (const [k, w] of banked) if (!next.has(k)) next.set(k, w);
      s.gear.value = next;
    } catch {
      /* see above — an unanswerable question falls back to the old behaviour */
    }
    if (mine === epoch && seq === issued) s.known.value = true;
  })();
  inFlight = run;
  try {
    await run;
  } finally {
    banking.delete(banked);
    // only clear the slot if it is still OURS — a reset (or a forced read) may
    // have replaced it while this one was out
    if (inFlight === run) inFlight = undefined;
  }
}

/**
 * Fold gear this device has just banked into the cache, so the button stands
 * down without a second round trip.
 *
 * `at` is the epoch the write was STARTED under (vaultKeysEpoch()). A capture
 * POST outlives the session that sent it — sign out mid-flight and the response
 * still arrives — and without this the previous account's gear was written back
 * into the Map the sign-out had just cleared, where the next person to sign in
 * read it as their own.
 *
 * Only ever ADDS, and only keys the SERVER said are live (see the capture
 * endpoint). Sending a key is not storing it: the upsert leaves a tombstone
 * tombstoned and drops new keys past the vault's ceiling in silence, and a
 * button hidden on gear the vault refused cannot be pressed again to fix it.
 */
export function noteVaultKeys(keys: VaultGearKey[], at: number): void {
  // No state means no row has ever asked, so there is nothing to keep honest —
  // and building it here would install the app-wide watcher and fire a GET from
  // a pagehide handler, for a document that is going away.
  if (!import.meta.client || !shared || !keys.length || at !== epoch) return;
  const next = new Map(shared.gear.value);
  for (const [k, w] of keys) {
    if (!k) continue;
    next.set(k, w);
    // and tell any read still out about it, so its answer — built before this
    // write reached the server — doesn't drop what we just banked
    for (const pending of banking) pending.set(k, w);
  }
  shared.gear.value = next;
}

/** The epoch a write should carry to noteVaultKeys — read it BEFORE the request
 *  goes out, so an answer that arrives after the account changed is discarded. */
export function vaultKeysEpoch(): number {
  return epoch;
}

/** Drop everything on the way out of an account, so the next person to sign in
 *  on this device doesn't inherit a stranger's gear as "already yours". Paired
 *  with resetVaultCapture in useSession.forgetAccountMemos. */
export function resetVaultKeys(): void {
  if (!import.meta.client) return;
  invalidate(); // which releases the give-up timer too
}

export function useVaultKeys() {
  // Building the singleton is what starts the first fetch, so the first row to
  // mount puts the answer on its way and the other 149 join it. A pure accessor
  // otherwise: the watcher owns every re-ask, because every re-ask is a session
  // change and the watcher is what sees those.
  const s = state();
  return {
    vaultGear: s.gear,
    vaultKeysKnown: s.known,
    /** Re-read from the server — for the points where the vault may have changed
     *  behind the editor's back (another tab, or an edit on /gear). */
    refreshVaultKeys: () => load(true),
  };
}
