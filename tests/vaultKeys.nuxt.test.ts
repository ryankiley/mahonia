// @vitest-environment nuxt
//
// useVaultKeys — the read that tells a list row whether My Gear already holds its
// gear. Small, but load-bearing in three ways that are easy to break by accident:
//
//  • it is a SINGLETON. A 150-row list asks per row, and a per-caller copy would
//    be 150 refs and 150 requests racing each other.
//  • it never asks signed out. The editor is prerendered and most visitors have
//    no account; a round trip on every one of their page loads is the cost the
//    session hint exists to avoid (see useSession.refresh).
//  • it settles when the answer can't be had. Leaving it un-answered would hide a
//    working button behind a request that may never land.
//
// Nuxt environment because the thing under test is a composable over useState and
// $fetch — there is no pure function underneath to test instead.
import { beforeEach, describe, expect, it } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { createError } from "h3";
import { noteVaultKeys, resetVaultKeys, useVaultKeys } from "~/composables/useVaultKeys";

const hasVault = ref(true);
const vaultKnown = ref(true);

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault,
  vaultKnown,
  vaultFetch: <T,>(url: string, opts?: Parameters<typeof $fetch>[1]) =>
    $fetch(url, { ...opts, credentials: "same-origin" }) as Promise<T>,
}));

const DUPLEX = "zpacks duplex";
let calls = 0;
let fails = false;
/** Set to hold the read open, so a case can decide what happens WHILE it's out. */
let hold: Promise<void> | null = null;
registerEndpoint("/api/vault/keys", async () => {
  calls++;
  if (hold) await hold;
  if (fails) throw createError({ statusCode: 503 });
  return { keys: [DUPLEX] };
});

/** Let the load kicked off by a ref change (or by a call) actually land. */
const settle = async () => {
  await nextTick();
  await new Promise((r) => setTimeout(r, 0));
};

describe("useVaultKeys", () => {
  // Restore the dials, let any load their change kicked off land, and only THEN
  // clear the singleton — so every case starts un-answered with a clean count,
  // whatever the case before it left in flight.
  beforeEach(async () => {
    hasVault.value = true;
    vaultKnown.value = true;
    fails = false;
    hold = null;
    await settle();
    resetVaultKeys();
    calls = 0;
  });

  it("asks once, however many rows ask it", async () => {
    const first = useVaultKeys();
    for (let i = 0; i < 20; i++) useVaultKeys();
    await settle();
    expect(calls).toBe(1);
    expect(first.vaultKeysKnown.value).toBe(true);
    expect(first.vaultKeys.value.has(DUPLEX)).toBe(true);
    // ...and every caller sees the SAME set, which is the point of the singleton
    expect(useVaultKeys().vaultKeys.value).toBe(first.vaultKeys.value);
  });

  it("asks nothing signed out — there is no vault for gear to be in", async () => {
    hasVault.value = false;
    const { vaultKeys, vaultKeysKnown } = useVaultKeys();
    await settle();
    expect(calls).toBe(0);
    // and it is an ANSWER, not a wait: nothing is banked, so every worthy row
    // gets its button immediately rather than after a round trip that never comes
    expect(vaultKeysKnown.value).toBe(true);
    expect(vaultKeys.value.size).toBe(0);
  });

  it("waits for the session, then asks as soon as it answers", async () => {
    vaultKnown.value = false;
    const { vaultKeysKnown } = useVaultKeys();
    await settle();
    expect(calls).toBe(0);
    expect(vaultKeysKnown.value).toBe(false);

    vaultKnown.value = true; // /api/auth/me lands
    await settle();
    expect(calls).toBe(1);
    expect(vaultKeysKnown.value).toBe(true);
  });

  it("settles as known-with-nothing when the read fails", async () => {
    // offline, rate-limited, a blip. The row then falls back to the list's own
    // capture answer — exactly where the button stood before this read existed —
    // instead of staying hidden for the rest of the session.
    fails = true;
    const { vaultKeys, vaultKeysKnown } = useVaultKeys();
    await settle();
    expect(vaultKeysKnown.value).toBe(true);
    expect(vaultKeys.value.size).toBe(0);
  });

  it("re-reads on demand, so an edit on /gear isn't missed", async () => {
    const { refreshVaultKeys } = useVaultKeys();
    await settle();
    expect(calls).toBe(1);
    await refreshVaultKeys();
    expect(calls).toBe(2);
  });

  it("folds in a key just banked, without a round trip", async () => {
    const { vaultKeys } = useVaultKeys();
    await settle();
    calls = 0;
    noteVaultKeys(["durston kakwa 55"]);
    expect(vaultKeys.value.has("durston kakwa 55")).toBe(true);
    expect(vaultKeys.value.has(DUPLEX)).toBe(true); // added, never replaced
    expect(calls).toBe(0);
  });

  it("disowns a read still out when the account ends", async () => {
    // Signing out clears the set — and then the read that was already in flight
    // lands. Without the epoch it wrote the last person's gear straight back into
    // the set the sign-out had just emptied, which is the leak the reset exists
    // to close, arriving a few hundred milliseconds late.
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const { vaultKeys, vaultKeysKnown } = useVaultKeys();
    await settle();
    expect(calls).toBe(1);
    expect(vaultKeysKnown.value).toBe(false); // still out

    resetVaultKeys(); // sign out
    release();
    hold = null;
    await settle();
    expect(vaultKeys.value.size).toBe(0);
    expect(vaultKeysKnown.value).toBe(false); // and un-answered, not answered-wrong
  });

  it("drops everything on the way out of an account", async () => {
    const { vaultKeys, vaultKeysKnown } = useVaultKeys();
    await settle();
    expect(vaultKeys.value.size).toBe(1);
    resetVaultKeys();
    expect(vaultKeys.value.size).toBe(0);
    // and un-answered, not answered-empty: the next person's vault is unread, not
    // known to be empty
    expect(vaultKeysKnown.value).toBe(false);
  });
});
