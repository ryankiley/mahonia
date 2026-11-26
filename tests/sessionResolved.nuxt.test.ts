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
// A request held at the server until a case lets it go, for the cases about what
// changes WHILE one is out. The answer is fixed on arrival, as a server's is: it
// speaks for the cookie the request came in with, whatever the browser holds since.
let hold: Promise<void> | null = null;
let asked = 0;
registerEndpoint("/api/auth/me", async () => {
  asked++;
  const mine = answer;
  if (hold) await hold;
  if (mine === "down") throw createError({ statusCode: 503, statusMessage: "Unreachable" });
  if (mine === "one") return { user: { owner: "1", email: "ryan@example.com", displayName: null } };
  if (mine === "two") return { user: { owner: "2", email: "sam@example.com", displayName: null } };
  return { user: null };
});
registerEndpoint("/api/account/profile", () => ({ ok: true, displayName: "Ryan" }));

const ROWS_KEY = "gear.claimed.rows.v2.1";
const OPENS_KEY = "gear.claimed.opens.v2.1";

beforeEach(() => {
  storage.clear();
  answer = "no-user";
  document.cookie = "mh_signed_in=1; path=/";
  document.cookie = "mh_session_owner=1; path=/";
  useState<unknown>("session").value = { state: "unresolved" };
  useState<boolean>("session-pending").value = false;
  useClaimedLists().resetClaimMark();
  hold = null;
  asked = 0;
});

// A sign-in finishing while an earlier ask is still out. The earlier answer speaks
// for the session that was there before; applied as though it were about the new
// one, it dropped the new session's memos as "the previous owner's" and, when it
// said "no user", cleared the new session's hint cookie, leaving a signed-in
// browser reading as signed out.
describe("an answer that arrives after the session has changed", () => {
  const ROWS_TWO = "gear.claimed.rows.v2.2";
  /** A request put to the server and held there; `release` lets it answer. */
  function held() {
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    return () => {
      hold = null;
      release();
    };
  }
  /** What a sign-in elsewhere leaves behind: the new session's cookies and memos. */
  function signInAsTwo() {
    document.cookie = "mh_signed_in=1; path=/";
    document.cookie = "mh_session_owner=2; path=/";
    storage.set(ROWS_TWO, JSON.stringify([{ shareCode: "C0DE00000002", title: "Wonderland" }]));
    answer = "two";
  }

  it("is not taken for the new session's: it asks again, and the new memos stand", async () => {
    answer = "no-user"; // the session this browser held has ended
    const release = held();
    const first = useSession().refresh();
    signInAsTwo();
    release();
    await first;

    expect(asked).toBe(2);
    expect(useSession().user.value?.owner).toBe("2");
    expect(storage.has(ROWS_TWO)).toBe(true);
    expect(document.cookie).toContain("mh_signed_in=1");
  });

  it("still lets go of what was kept for the session before, which the re-ask never saw", async () => {
    // A tab that hadn't resolved yet: the previous account is known only by its
    // cookie, and by the lists a cold start put in the switcher from its cache.
    // The re-ask starts with the NEW marker in the cookie, so it has to be told.
    storage.set(ROWS_KEY, JSON.stringify([{ shareCode: "C0DE00000009", title: "Timberline" }]));
    markClaimedOpen("C0DE00000009");
    const claimed = useClaimedLists();
    claimed.restoreFromDevice();
    expect(claimed.lists.value.map((l) => l.title)).toEqual(["Timberline"]);

    answer = "one";
    const release = held();
    const first = useSession().refresh();
    signInAsTwo();
    release();
    await first;

    expect(useSession().user.value?.owner).toBe("2");
    // the first account's lists are out of the switcher and off the device
    expect(claimed.lists.value.map((l) => l.title)).not.toContain("Timberline");
    expect(storage.has(ROWS_KEY)).toBe(false);
    expect(storage.has(OPENS_KEY)).toBe(false);
    // and the new account's are untouched
    expect(storage.has(ROWS_TWO)).toBe(true);
  });

  it("counts the stale ask's own re-read as the forced one: two requests, not three", async () => {
    // the sign-in page's case exactly: its forced re-read arrives while the page's
    // first ask is out, and that ask is about the session before the sign-in
    answer = "no-user";
    const release = held();
    const first = useSession().refresh();
    signInAsTwo();
    const forced = useSession().refresh(true);
    release();
    await Promise.all([first, forced]);

    expect(asked).toBe(2);
    expect(useSession().user.value?.owner).toBe("2");
  });

  it("reads a user as stale once the hint that there is one has gone", async () => {
    // a session too old to have a marker cookie, signed out in another tab while
    // it was being asked about: no marker ever changed, only the hint went
    document.cookie = "mh_session_owner=; Max-Age=0; path=/";
    answer = "one";
    const release = held();
    const first = useSession().refresh();
    document.cookie = "mh_signed_in=; Max-Age=0; path=/";
    release();
    await first;

    expect(useSession().signedIn.value).toBe(false);
    expect(useSession().loaded.value).toBe(true);
  });

  it("settles signed out when the session went away while it was asked about", async () => {
    answer = "one";
    const release = held();
    const first = useSession().refresh();
    // signed out in another tab: the cookies are gone before the answer lands
    document.cookie = "mh_signed_in=; Max-Age=0; path=/";
    document.cookie = "mh_session_owner=; Max-Age=0; path=/";
    release();
    await first;

    expect(asked).toBe(1);
    expect(useSession().signedIn.value).toBe(false);
    expect(useSession().loaded.value).toBe(true);
  });

  it("makes a forced re-read wait its turn and then really ask", async () => {
    answer = "one";
    const release = held();
    const first = useSession().refresh();
    // forced twice over while the first is out: one more request, not two, and
    // neither caller is handed back the question it didn't ask
    const forced = useSession().refresh(true);
    const forcedAgain = useSession().refresh(true);
    expect(asked).toBe(1);
    release();
    await Promise.all([first, forced, forcedAgain]);

    expect(asked).toBe(2);
    expect(useSession().user.value?.owner).toBe("1");
  });

  it("still lets an unforced caller go without waiting or asking", async () => {
    answer = "one";
    const release = held();
    const first = useSession().refresh();
    await useSession().refresh(); // returns at once: one request, already out
    expect(asked).toBe(1);
    expect(useSession().loaded.value).toBe(false);
    release();
    await first;
    expect(useSession().user.value?.owner).toBe("1");
  });
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

describe("saving the display name", () => {
  it("adopts the answer into the signed-in user and leaves the rest of it alone", async () => {
    answer = "one";
    await useSession().refresh();
    expect(await useSession().saveProfile({ displayName: "Ryan" })).toBe(true);
    expect(useSession().user.value).toEqual({ owner: "1", email: "ryan@example.com", displayName: "Ryan" });
    expect(useSession().presence.value).toBe("signedIn");
  });

  it("never makes a user out of an answer that arrives with nobody signed in", async () => {
    expect(await useSession().saveProfile({ displayName: "Ryan" })).toBe(true);
    expect(useSession().user.value).toBeNull();
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

    expect(useSession().user.value?.owner).toBe("2");
    expect(claimed.lists.value).toEqual([]);
    expect(storage.has(ROWS_KEY)).toBe(false);
    expect(storage.has(OPENS_KEY)).toBe(false);
  });
});
