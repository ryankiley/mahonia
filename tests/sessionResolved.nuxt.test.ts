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
import { beforeEach, describe, expect, it } from "vitest";
import { stubLocalStorage } from "./helpers/storage";
import { registerEndpoint } from "@nuxt/test-utils/runtime";
import { createError } from "h3";

const storage = stubLocalStorage();

let answer: "one" | "two" | "no-user" | "down" = "no-user";
registerEndpoint("/api/auth/me", () => {
  if (answer === "down") throw createError({ statusCode: 503, statusMessage: "Unreachable" });
  if (answer === "one") return { user: { id: 1, email: "ryan@example.com", displayName: null } };
  if (answer === "two") return { user: { id: 2, email: "sam@example.com", displayName: null } };
  return { user: null };
});

const ROWS_KEY = "gear.claimed.rows.v2.1";
const OPENS_KEY = "gear.claimed.opens.v2.1";

beforeEach(() => {
  storage.clear();
  answer = "no-user";
  document.cookie = "mh_signed_in=1; path=/";
  document.cookie = "mh_session_owner=1; path=/";
  useState<unknown>("session-user").value = null;
  useState<boolean>("session-loaded").value = false;
  useState<boolean>("session-pending").value = false;
  useClaimedLists().resetClaimMark();
});

describe("a session that ends without a sign-out here", () => {
  it("clears the account's cached lists and opens ledger when the server says no user", async () => {
    storage.set(ROWS_KEY, JSON.stringify([{ shareCode: "C0DE00000009", title: "Timberline" }]));
    markClaimedOpen("C0DE00000009");
    // the stale hint seeded the rows, exactly as a cold launch does (the session
    // plugin restores before it asks the server)
    const claimed = useClaimedLists();
    claimed.restoreFromDevice();
    expect(claimed.lists.value.map((l) => l.title)).toEqual(["Timberline"]);

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
    markClaimedOpen("C0DE00000009");
    answer = "down";

    await useSession().refresh();

    expect(useSession().loaded.value).toBe(false); // unresolved, not signed out
    expect(storage.has(ROWS_KEY)).toBe(true);
    expect(storage.has(OPENS_KEY)).toBe(true);
  });
});

describe("a forced re-read that fails", () => {
  it("reads as unresolved, not as signed out", async () => {
    answer = "one";
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

describe("a resolved account replacement", () => {
  it("drops the former account's rows and resume ledger before B can see them", async () => {
    answer = "one";
    await useSession().refresh();
    const claimed = useClaimedLists();
    claimed.lists.value = [{
      shareCode: "C0DE00000009",
      slug: "as-list",
      title: "A's list",
      totalMg: 0,
      version: 1,
      displayUnit: "g",
      updatedAt: "",
    }];
    storage.set(ROWS_KEY, JSON.stringify(claimed.lists.value));
    markClaimedOpen("C0DE00000009");

    // A successful sign-in in another tab updates the shared, readable owner
    // marker before this tab re-reads /api/auth/me.
    document.cookie = "mh_session_owner=2; path=/";
    answer = "two";
    await useSession().refresh(true);

    expect(useSession().user.value?.id).toBe(2);
    expect(claimed.lists.value).toEqual([]);
    expect(storage.has(ROWS_KEY)).toBe(false);
    expect(storage.has(OPENS_KEY)).toBe(false);
  });
});
