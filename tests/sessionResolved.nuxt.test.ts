// @vitest-environment nuxt
//
// What this device keeps FOR an account, and when it lets go of it. Two ways a
// session ends never pass through signOut() on this browser — it expires, or it is
// ended elsewhere ("sign out everywhere", the account deleted) — and both surface
// here as /api/auth/me answering "no user" to a browser still holding the hint
// cookie. That answer has to clear the account's memos the way a sign-out does:
// left standing, the cached lists sat in the switcher until the menu opened, and
// the opens ledger steered the bare address into that account's lists for whoever
// signed in on the browser next.
//
// The other half is what a FAILED read means. `loaded` is the switcher's licence to
// throw the account's cached rows away ("resolved signed out"); a read that never
// got an answer must not grant it, however the read was started.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage } from "./helpers/storage";
import { registerEndpoint } from "@nuxt/test-utils/runtime";
import { createError } from "h3";

const storage = stubLocalStorage();

let answer: "signed-in" | "no-user" | "down" = "no-user";
let deferMe = false;
let settleMe: Array<() => void> = [];
registerEndpoint("/api/auth/me", async () => {
  if (answer === "down") throw createError({ statusCode: 503, statusMessage: "Unreachable" });
  // Freeze the answer at request time: a response sent before a sign-in must stay
  // an old signed-out answer even after the test changes the next request's answer.
  const response = { user: answer === "signed-in" ? { email: "ryan@example.com", displayName: null } : null };
  if (deferMe) await new Promise<void>((resolve) => settleMe.push(resolve));
  return response;
});
registerEndpoint("/api/auth/signout", { method: "POST", handler: () => ({ ok: true }) });

const ACCOUNT = "ryan@example.com";
const ROWS_KEY = `gear.claimed.rows.v1.${encodeURIComponent(ACCOUNT)}`;
const OPENS_KEY = `gear.claimed.opens.v1.${encodeURIComponent(ACCOUNT)}`;

beforeEach(() => {
  storage.clear();
  answer = "no-user";
  deferMe = false;
  settleMe = [];
  document.cookie = "mh_signed_in=1; path=/";
  useState<unknown>("session-user").value = null;
  useState<boolean>("session-loaded").value = false;
  useState<boolean>("session-pending").value = false;
  useState<number>("session-refresh-generation").value = 0;
  useState<number>("session-account-generation").value = 0;
  useClaimedLists().resetClaimMark();
});

afterEach(() => {
  deferMe = false;
  for (const settle of settleMe) settle();
  settleMe = [];
});

describe("a session that ends without a sign-out here", () => {
  it("clears the account's cached lists and opens ledger when the server says no user", async () => {
    storage.set(ROWS_KEY, JSON.stringify([{ shareCode: "C0DE00000009", title: "Timberline" }]));
    storage.set(OPENS_KEY, JSON.stringify({ C0DE00000009: 1 }));
    // A stale hint no longer seeds rows before identity is verified.
    const claimed = useClaimedLists();
    claimed.restoreFromDevice();
    expect(claimed.lists.value).toEqual([]);

    await useSession().refresh();

    expect(useSession().signedIn.value).toBe(false);
    expect(useSession().loaded.value).toBe(true);
    expect(claimed.lists.value).toEqual([]);
    expect(storage.has(ROWS_KEY)).toBe(false);
    expect(storage.has(OPENS_KEY)).toBe(false);
    expect(document.cookie).not.toContain("mh_signed_in=1");
  });

  it("leaves everything standing when the server is merely unreachable", async () => {
    storage.set(ROWS_KEY, JSON.stringify([{ shareCode: "C0DE00000009", title: "Timberline" }]));
    storage.set(OPENS_KEY, JSON.stringify({ C0DE00000009: 1 }));
    answer = "down";

    await useSession().refresh();

    expect(useSession().loaded.value).toBe(false); // unresolved, not signed out
    expect(storage.has(ROWS_KEY)).toBe(true);
    expect(storage.has(OPENS_KEY)).toBe(true);
  });
});

describe("a forced re-read that fails", () => {
  it("reads as unresolved, not as signed out", async () => {
    answer = "signed-in";
    await useSession().refresh();
    expect(useSession().signedIn.value).toBe(true);
    expect(useSession().loaded.value).toBe(true);

    // the connection drops right after a sign-in's forced re-read begins
    answer = "down";
    await useSession().refresh(true);

    expect(useSession().signedIn.value).toBe(false);
    // `loaded` stays the licence it was meant to be: a failure here used to leave it
    // true from the last success, and the switcher then threw the cached rows away
    expect(useSession().loaded.value).toBe(false);
  });
});

describe("competing session reads", () => {
  it("lets a forced post-sign-in read supersede an older signed-out response", async () => {
    answer = "no-user";
    deferMe = true;
    const oldRead = useSession().refresh();
    await vi.waitFor(() => expect(settleMe).toHaveLength(1));

    // A passkey ceremony has just set a new cookie. refresh(true) used to return
    // early because the old read had `pending` true; then this old answer cleared
    // the new hint and left the freshly signed-in visitor looking signed out.
    answer = "signed-in";
    deferMe = false;
    await useSession().refresh(true);
    expect(useSession().signedIn.value).toBe(true);

    settleMe[0]!();
    await oldRead;
    expect(useSession().signedIn.value).toBe(true);
    expect(document.cookie).toContain("mh_signed_in=1");
  });

  it("does not let an old signed-in response undo a local sign-out", async () => {
    answer = "signed-in";
    deferMe = true;
    const oldRead = useSession().refresh();
    await vi.waitFor(() => expect(settleMe).toHaveLength(1));

    await useSession().signOut();
    expect(useSession().signedIn.value).toBe(false);

    settleMe[0]!();
    await oldRead;
    expect(useSession().signedIn.value).toBe(false);
    expect(document.cookie).not.toContain("mh_signed_in=1");
  });
});
