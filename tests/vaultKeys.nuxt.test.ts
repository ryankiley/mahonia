// @vitest-environment nuxt
//
// useVaultKeys — the read that tells a list row whether My Gear already holds its
// gear, and at what weight. Small, but load-bearing in ways that are easy to
// break by accident:
//
//  • it is a SINGLETON. A 150-row list asks per row, and a per-caller copy would
//    be 150 refs and 150 requests racing each other.
//  • it never asks signed out. The editor is prerendered and most visitors have
//    no account; a round trip on every one of their page loads is the cost the
//    session hint exists to avoid (see useSession.refresh).
//  • it must forget on every SESSION CHANGE, not just on sign-out. An answer
//    about the last account is not an answer about this one — and because the
//    signed-out branch settles `known`, an in-page sign-in that skipped the
//    invalidation left the cache saying "your vault is empty" for the rest of the
//    page, which reinstates the whole bug this composable removes.
//  • it must settle even when it can't be answered. The row holds its save button
//    back while this is unanswered, so an unbounded wait is a button hidden for
//    good.
//
// Nuxt environment because the thing under test is a composable over useState and
// $fetch — there is no pure function underneath to test instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { createError } from "h3";
import {
  noteVaultKeys,
  resetVaultKeys,
  useVaultKeys,
  vaultKeysEpoch,
} from "~/composables/useVaultKeys";

const hasVault = ref(true);
const vaultKnown = ref(true);

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault,
  vaultKnown,
  vaultFetch: <T,>(url: string, opts?: Parameters<typeof $fetch>[1]) =>
    $fetch(url, { ...opts, credentials: "same-origin" }) as Promise<T>,
}));

const DUPLEX = "zpacks duplex";
const KAKWA = "durston kakwa 55";
let calls = 0;
let fails = false;
/** Set to hold the read open, so a case can decide what happens WHILE it's out. */
let hold: Promise<void> | null = null;
/** What the server currently says the vault holds. */
let serverKeys: [string, number | null][] = [[DUPLEX, 539_000]];
registerEndpoint("/api/vault/keys", async () => {
  calls++;
  if (hold) await hold;
  if (fails) throw createError({ statusCode: 503 });
  return { keys: serverKeys };
});

/** Let a load kicked off by a ref change actually land. */
const settle = async () => {
  await nextTick();
  await new Promise((r) => setTimeout(r, 0));
};

/** Drive the session the way the app does — a ref change is what the singleton's
 *  watcher reacts to, and the only thing that invalidates a stale answer. */
const sessionAnswers = async (signedIn: boolean) => {
  vaultKnown.value = true;
  hasVault.value = signedIn;
  await settle();
};

describe("useVaultKeys", () => {
  // Park the session UNANSWERED before each case, so every one starts from a
  // clean un-loaded cache with a zeroed count and drives the session itself.
  beforeEach(async () => {
    fails = false;
    hold = null;
    serverKeys = [[DUPLEX, 539_000]];
    hasVault.value = false;
    vaultKnown.value = false;
    await settle();
    resetVaultKeys();
    calls = 0;
  });

  afterEach(() => resetVaultKeys()); // clears the session-wait timer

  it("asks once, however many rows ask it", async () => {
    const first = useVaultKeys();
    for (let i = 0; i < 20; i++) useVaultKeys();
    await sessionAnswers(true);
    expect(calls).toBe(1);
    expect(first.vaultKeysKnown.value).toBe(true);
    expect(first.vaultGear.value.get(DUPLEX)).toBe(539_000);
    // ...and every caller sees the SAME Map, which is the point of the singleton
    expect(useVaultKeys().vaultGear.value).toBe(first.vaultGear.value);
  });

  it("asks nothing signed out — there is no vault for gear to be in", async () => {
    const { vaultGear, vaultKeysKnown } = useVaultKeys();
    await sessionAnswers(false);
    expect(calls).toBe(0);
    // and it is an ANSWER, not a wait: nothing is banked, so every worthy row
    // gets its button immediately rather than after a round trip that never comes
    expect(vaultKeysKnown.value).toBe(true);
    expect(vaultGear.value.size).toBe(0);
  });

  it("waits for the session, then asks as soon as it answers", async () => {
    const { vaultKeysKnown } = useVaultKeys();
    await settle();
    expect(calls).toBe(0);
    expect(vaultKeysKnown.value).toBe(false);

    await sessionAnswers(true); // /api/auth/me lands
    expect(calls).toBe(1);
    expect(vaultKeysKnown.value).toBe(true);
  });

  it("reads the new account's vault when someone signs in mid-session", async () => {
    // THE REGRESSION. Signing in from the editor never navigates, so no list is
    // reopened and nothing else re-reads. The signed-out branch settles `known`,
    // so without the watcher's invalidation the load for the new session found
    // `known` already true and returned — leaving the cache asserting "your vault
    // is empty" for the rest of the page, and every row back on the old per-list
    // proxy, offering to save gear banked months ago.
    const { vaultGear, vaultKeysKnown } = useVaultKeys();
    await sessionAnswers(false);
    expect(calls).toBe(0);
    expect(vaultKeysKnown.value).toBe(true); // settled as "nothing banked"

    await sessionAnswers(true); // passkey sign-in, same page
    expect(calls).toBe(1);
    expect(vaultGear.value.get(DUPLEX)).toBe(539_000);
  });

  it("does not hand one account's gear to the next", async () => {
    const { vaultGear } = useVaultKeys();
    await sessionAnswers(true);
    expect(vaultGear.value.has(DUPLEX)).toBe(true);

    await sessionAnswers(false); // sign out
    expect(vaultGear.value.size).toBe(0);

    serverKeys = [[KAKWA, 900_000]]; // a different person's vault
    await sessionAnswers(true);
    expect(vaultGear.value.has(DUPLEX)).toBe(false);
    expect(vaultGear.value.get(KAKWA)).toBe(900_000);
  });

  it("settles as known-with-nothing when the read fails", async () => {
    // offline, rate-limited, a blip. The row then falls back to the list's own
    // capture answer — exactly where the button stood before this read existed —
    // instead of staying hidden for the rest of the session.
    fails = true;
    const { vaultGear, vaultKeysKnown } = useVaultKeys();
    await sessionAnswers(true);
    expect(vaultKeysKnown.value).toBe(true);
    expect(vaultGear.value.size).toBe(0);
  });

  it("gives up on a session that never answers, rather than waiting forever", async () => {
    // useSession.refresh() leaves `loaded` false when /api/auth/me fails so a
    // later call can retry — but the only caller is the one-shot boot plugin, so
    // offline it never answers at all. The row holds its button back while this
    // is unanswered, so an unbounded wait hid the save button on every row of
    // every list for the whole session, with no way to get it back.
    vi.useFakeTimers();
    try {
      const { vaultKeysKnown } = useVaultKeys();
      hasVault.value = true; // a change the watcher sees; the session still hasn't answered
      await nextTick();
      expect(vaultKeysKnown.value).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(vaultKeysKnown.value).toBe(true);
      expect(calls).toBe(0); // gave up on the session; never asked the vault
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads on demand, so an edit on /gear isn't missed", async () => {
    const { refreshVaultKeys, vaultGear } = useVaultKeys();
    await sessionAnswers(true);
    expect(calls).toBe(1);
    serverKeys = [[DUPLEX, 539_000], [KAKWA, 900_000]];
    await refreshVaultKeys();
    expect(calls).toBe(2);
    expect(vaultGear.value.has(KAKWA)).toBe(true);
  });

  it("folds in gear just banked, without a round trip", async () => {
    const { vaultGear } = useVaultKeys();
    await sessionAnswers(true);
    calls = 0;
    noteVaultKeys([[KAKWA, 900_000]], vaultKeysEpoch());
    expect(vaultGear.value.get(KAKWA)).toBe(900_000);
    expect(vaultGear.value.has(DUPLEX)).toBe(true); // added, never replaced
    expect(calls).toBe(0);
  });

  it("keeps gear banked while a read was in flight", async () => {
    // The read's answer was built BEFORE the capture reached the server, so a
    // wholesale replace dropped the key — and a duplicate of that gear further
    // down the list went straight back to offering the button it had just lost.
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const { vaultGear, refreshVaultKeys } = useVaultKeys();
    await sessionAnswers(true);
    void refreshVaultKeys();
    await settle();

    noteVaultKeys([[KAKWA, 900_000]], vaultKeysEpoch()); // a press lands mid-read
    release();
    hold = null;
    await settle();
    expect(vaultGear.value.has(KAKWA)).toBe(true);
    expect(vaultGear.value.has(DUPLEX)).toBe(true); // and the read still wins for its own
  });

  it("drops a capture that answers after the account changed", async () => {
    // A capture POST outlives the session that sent it: sign out mid-flight and
    // the response still arrives. Writing its keys in would hand the next person
    // to sign in on this device a stranger's gear as "already yours".
    const { vaultGear } = useVaultKeys();
    await sessionAnswers(true);
    const stale = vaultKeysEpoch(); // the epoch the in-flight capture started under

    await sessionAnswers(false); // sign out while it is out
    noteVaultKeys([[DUPLEX, 539_000]], stale);
    expect(vaultGear.value.size).toBe(0);
  });

  it("disowns a read still out when the account ends", async () => {
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const { vaultGear, vaultKeysKnown } = useVaultKeys();
    vaultKnown.value = true;
    hasVault.value = true;
    await nextTick();
    expect(calls).toBe(1);
    expect(vaultKeysKnown.value).toBe(false); // still out

    resetVaultKeys(); // sign out
    release();
    hold = null;
    await settle();
    expect(vaultGear.value.size).toBe(0);
    expect(vaultKeysKnown.value).toBe(false); // and un-answered, not answered-wrong
  });

  it("never rejects, so a caller can void it on the list-open path", async () => {
    // useGearList.load() fires this and moves on. `void` is not a catch, so a
    // throw here would surface as an unhandled rejection over the editor.
    fails = true;
    const { refreshVaultKeys } = useVaultKeys();
    await sessionAnswers(true);
    await expect(refreshVaultKeys()).resolves.toBeUndefined();
  });
});
