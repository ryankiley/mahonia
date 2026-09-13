// @vitest-environment nuxt
//
// The account half of "your lists", as the DEVICE holds it: the sign-in sweep that
// attaches this browser's lists to the account, and the two things this browser
// keeps of the answer so that half still exists with no network — the cached rows
// and the ledger of which claimed lists it has actually had open.
//
// The sign-in sweep — what the browser sends the claim endpoint, and when it
// bothers sending anything at all.
//
// The split matters: rows this browser made go in `editTokens` and are claimed
// outright, rows that arrived through someone else's link go in `openedTokens`
// and are only ever claimed under the server's narrower rule (a list from before
// origin tracking, whose mark was never recorded — see server/utils/claimRepo).
// Sending the second bucket is what lets a pre-accounts list that got stamped by a
// reopen reach the account without anyone pressing anything; NOT claiming on the
// strength of it is what keeps a shared list out of your account.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listEntry } from "./helpers/myLists";
import { stubLocalStorage } from "./helpers/storage";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { readBody } from "h3";
import { CLAIMED_LIST_CAP, type ClaimedList, type MyListEntry } from "~~/shared/types";

// The session plugin is the app's OWN driver of the sweep: it watches the registry
// and the session and calls claimDeviceLists itself. This suite drives the sweep by
// hand and counts what reaches the server, so the plugin stays out — with it in,
// every `entries` reset below fired a claim of its own behind the case's back (and
// one that came back with no rows pruned the ledger a case had just written).
vi.mock("../app/plugins/session.client", () => ({ default: () => {} }));

const signedIn = ref(true);
const sessionLoaded = ref(true);
// the readable companion flag to the session cookie — the one "is there an account
// here" answer that survives having no network to ask with
const hasHint = ref(true);
// what a forced re-read of the session does here; a case sets it to model another
// tab having signed in since this one resolved
let onRefresh: () => void = () => {};
mockNuxtImport("useSession", () => () => ({
  signedIn,
  loaded: sessionLoaded,
  hasSessionHint: () => hasHint.value,
  // the real composable's three-way rule, mirrored so the gates under test read the
  // session exactly as the app does
  presence: computed(() =>
    sessionLoaded.value ? (signedIn.value ? "signedIn" : "signedOut") : hasHint.value ? "presumed" : "signedOut",
  ),
  refresh: async () => onRefresh(),
}));

const entries = ref<MyListEntry[]>([]);
mockNuxtImport("useMyLists", () => () => ({ entries }));

const storage = stubLocalStorage();

// The real request, intercepted at the endpoint — `$fetch` is resolved by the
// auto-import at call time, so stubbing the global doesn't catch it (the live one
// runs, fails, and disappears into the composable's catch, which reads as "sent
// nothing" and passes the wrong tests).
interface ClaimBody {
  editTokens: string[];
  openedTokens: string[];
}
const posted: ClaimBody[] = [];
registerEndpoint("/api/lists/claim", {
  method: "POST",
  handler: async (event) => {
    const body = await readBody<ClaimBody>(event);
    posted.push({ editTokens: body.editTokens ?? [], openedTokens: body.openedTokens ?? [] });
    return { claimed: 0, lists: [] };
  },
});
let served: Partial<ClaimedList>[] = [];
registerEndpoint("/api/lists/claimed", () => ({ lists: served }));
registerEndpoint("/api/lists/unclaim", { method: "POST", handler: () => ({ ok: true }) });

// Rows here PREDATE origin tracking unless a case says otherwise: the sweep's whole
// subject is what the server does with rows that never recorded how they arrived.
const entry = (over: Partial<MyListEntry> & { editToken: string }): MyListEntry =>
  listEntry({ origin: undefined, lastOpened: 0, ...over });

beforeEach(() => {
  signedIn.value = true;
  sessionLoaded.value = true;
  hasHint.value = true;
  entries.value = [];
  storage.clear();
  document.cookie = "mh_session_owner=1; path=/";
  posted.length = 0;
  served = [];
  onRefresh = () => {};
  // useState is shared for the whole file, and the cache seed is gated on both
  // `lists` and `loaded` — a case that left rows standing (or a landed fetch) would
  // decide the next one's answer. The composable's own "back to nothing".
  useClaimedLists().resetClaimMark();
});

describe("claimDeviceLists — what goes to the server", () => {
  it("splits the registry into owned and opened buckets", async () => {
    entries.value = [
      entry({ editToken: "mine", origin: "created" }),
      entry({ editToken: "legacy" }), // predates the field
      entry({ editToken: "theirs", origin: "opened", shareCode: "C0DE00000002" }),
    ];

    await useClaimedLists().claimDeviceLists();

    expect(posted).toHaveLength(1);
    // an absent origin is still treated as yours — the guess this app has always made
    expect([...posted[0]!.editTokens].sort()).toEqual(["legacy", "mine"]);
    // sent, but the server decides; being in this array claims nothing by itself
    expect(posted[0]!.openedTokens).toEqual(["theirs"]);
  });

  it("sends a registry that is nothing BUT opened rows", async () => {
    // the stranded case: the only list on this device got stamped by a reopen. The
    // old sweep sent an empty array here and the account never heard of it.
    entries.value = [entry({ editToken: "stamped", origin: "opened" })];

    await useClaimedLists().claimDeviceLists();

    expect(posted).toEqual([{ editTokens: [], openedTokens: ["stamped"] }]);
  });

  it("re-runs when only an opened row changes", async () => {
    entries.value = [entry({ editToken: "mine", origin: "created" })];
    await useClaimedLists().claimDeviceLists();
    expect(posted).toHaveLength(1);

    // a fingerprint over one bucket would call this "no change" and skip it
    entries.value = [...entries.value, entry({ editToken: "opened-one", origin: "opened" })];
    await useClaimedLists().claimDeviceLists();

    expect(posted).toHaveLength(2);
    expect(posted[1]!.openedTokens).toEqual(["opened-one"]);
  });

  it("skips the request when the whole registry is unchanged", async () => {
    entries.value = [
      entry({ editToken: "mine", origin: "created" }),
      entry({ editToken: "theirs", origin: "opened" }),
    ];
    await useClaimedLists().claimDeviceLists();
    expect(posted).toHaveLength(1); // the mark is only written by a real send
    posted.length = 0;

    await useClaimedLists().claimDeviceLists();

    expect(posted).toEqual([]);
  });

  it("does nothing at all signed out", async () => {
    signedIn.value = false;
    entries.value = [entry({ editToken: "mine", origin: "created" })];

    await useClaimedLists().claimDeviceLists();

    expect(posted).toEqual([]);
  });
});

const ROWS_KEY = "gear.claimed.rows.v2.1";
const OPENS_KEY = "gear.claimed.opens.v2.1";
const cachedTitles = () =>
  (JSON.parse(storage.get(ROWS_KEY) ?? "[]") as ClaimedList[]).map((l) => l.title);

describe("the account's lists survive losing the network", () => {
  it("mirrors what the server returned onto the device", async () => {
    served = [{ shareCode: "C0DE00000009", title: "Timberline" }];

    await useClaimedLists().refresh();

    expect(cachedTitles()).toEqual(["Timberline"]);
  });

  it("reads them back on a cold launch, before anything has been fetched", () => {
    // the switcher on an offline start: no session read has answered, so the only
    // copy of the account's lists is the one this browser kept — restored once at
    // boot by the session plugin, which is what this call stands in for
    storage.set(ROWS_KEY, JSON.stringify([{ shareCode: "C0DE00000009", title: "Timberline" }]));
    sessionLoaded.value = false;

    const claimed = useClaimedLists();
    claimed.restoreFromDevice();

    expect(claimed.lists.value.map((l) => l.title)).toEqual(["Timberline"]);
  });

  it("does not read them back with no account behind this browser", () => {
    storage.set(ROWS_KEY, JSON.stringify([{ shareCode: "C0DE00000009", title: "Timberline" }]));
    sessionLoaded.value = false;
    hasHint.value = false;

    const claimed = useClaimedLists();
    claimed.restoreFromDevice();

    expect(claimed.lists.value).toEqual([]);
  });

  it("follows the cache across tabs: a read elsewhere fills the switcher, a sign-out empties it", () => {
    const claimed = useClaimedLists();
    claimed.restoreFromDevice(); // starts following
    expect(claimed.lists.value).toEqual([]);

    // another tab's read landing — the browser fires "storage" in every OTHER tab
    storage.set(ROWS_KEY, JSON.stringify([{ shareCode: "C0DE00000009", title: "From the other tab" }]));
    window.dispatchEvent(new StorageEvent("storage", { key: ROWS_KEY }));
    expect(claimed.lists.value.map((l) => l.title)).toEqual(["From the other tab"]);

    // ...and its sign-out removing the key
    storage.delete(ROWS_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: ROWS_KEY }));
    expect(claimed.lists.value).toEqual([]);
  });

  it("asks the session again before blanking when the hint has come back", async () => {
    // This tab resolved signed-out; another tab has since signed in (the cookie is
    // shared) and cached the account's rows. Blanking on the stale answer threw
    // those rows away; a re-read finds the session and reads the rows instead.
    storage.set(ROWS_KEY, JSON.stringify([{ shareCode: "C0DE00000009", title: "Timberline" }]));
    signedIn.value = false;
    sessionLoaded.value = true;
    onRefresh = () => {
      signedIn.value = true;
    };
    served = [{ shareCode: "C0DE00000009", title: "Timberline" }];

    const claimed = useClaimedLists();
    await claimed.refresh();

    expect(claimed.lists.value.map((l) => l.title)).toEqual(["Timberline"]);
    expect(storage.has(ROWS_KEY)).toBe(true);
  });

  it("does not blank them while the session is merely unresolved", async () => {
    // offline, /api/auth/me fails and signedIn reads false for someone signed in —
    // blanking there emptied the switcher at the one moment the cache was the only
    // copy this device had
    storage.set(ROWS_KEY, JSON.stringify([{ shareCode: "C0DE00000009", title: "Timberline" }]));
    signedIn.value = false;
    sessionLoaded.value = false;

    const claimed = useClaimedLists();
    claimed.restoreFromDevice(); // the boot-time seed, as the session plugin runs it
    await claimed.refresh();

    expect(claimed.lists.value.map((l) => l.title)).toEqual(["Timberline"]);
    expect(cachedTitles()).toEqual(["Timberline"]);
  });

  it("clears them once the server has actually said signed out — the ledger too", async () => {
    storage.set(ROWS_KEY, JSON.stringify([{ shareCode: "C0DE00000009", title: "Timberline" }]));
    markClaimedOpen("C0DE00000009");
    signedIn.value = false;
    sessionLoaded.value = true;

    const claimed = useClaimedLists();
    await claimed.refresh();

    expect(claimed.lists.value).toEqual([]);
    // removed, not written as "[]" — a visitor with no account leaves no key behind
    expect(storage.has(ROWS_KEY)).toBe(false);
    // a claimed resume is only as good as the session, and this is the session over
    expect(storage.has(OPENS_KEY)).toBe(false);
  });

  it("never writes the cache from an edit made in this tab", () => {
    // touchByCode mirrors a rename onto the row the switcher reads, in memory. The
    // device cache is the server's last answer; written from here it became this
    // tab's idea of the account — stale rows after a sign-out in another tab, or
    // "[]" before the first read had landed.
    const claimed = useClaimedLists();
    claimed.lists.value = [
      { shareCode: "C0DE00000009", slug: "t", title: "Timberline", totalMg: 0, version: 1, displayUnit: "g", updatedAt: "" },
    ];

    claimed.touchByCode("C0DE00000009", { title: "Timberline, renamed" });

    expect(claimed.lists.value[0]!.title).toBe("Timberline, renamed");
    expect(storage.has(ROWS_KEY)).toBe(false);
  });

  it("keeps the ledger to the lists the account actually holds", async () => {
    // A list unclaimed or deleted on ANOTHER device never answers 401 here; the
    // server's rows are the one place its absence shows, so every read prunes.
    markClaimedOpen("C0DE00000001");
    markClaimedOpen("C0DE00000002");
    served = [{ shareCode: "C0DE00000002", title: "Still mine" }];

    await useClaimedLists().refresh();

    expect(claimedOpens().map((c) => c.shareCode)).toEqual(["C0DE00000002"]);
  });

  it("does not prune against an answer that hit the server's cap", async () => {
    // 200 rows back means "at least 200", not "these and no others"
    markClaimedOpen("ZZZZZZZZZZZ9");
    served = Array.from({ length: CLAIMED_LIST_CAP }, (_, i) => ({
      shareCode: `C${String(i).padStart(11, "0")}`,
      title: `List ${i}`,
    }));

    await useClaimedLists().refresh();

    expect(claimedOpens().map((c) => c.shareCode)).toEqual(["ZZZZZZZZZZZ9"]);
  });

  it("reads only what it writes: canonical codes with finite stamps, object rows", () => {
    // An array ledger yields index keys — "/e/0" as a resume target that nothing
    // could ever forget; a stamp stored as a string sorts as NaN and evicts the real
    // ones on the next write; a null row throws in the switcher's render.
    storage.set(OPENS_KEY, "[1700000000000]");
    expect(claimedOpens()).toEqual([]);

    storage.set(OPENS_KEY, JSON.stringify({ __proto__: 1, "0": 2, "not a code": 3, C0DE00000001: "4", C0DE00000002: 5 }));
    expect(claimedOpens()).toEqual([{ shareCode: "C0DE00000002", lastOpened: 5 }]);
    // ...and the next write carries only the clean set forward
    markClaimedOpen("C0DE00000003");
    expect(JSON.parse(storage.get(OPENS_KEY)!)).toEqual({ C0DE00000002: 5, C0DE00000003: expect.any(Number) });

    storage.set(ROWS_KEY, JSON.stringify([null, 7, { shareCode: "C0DE00000009", title: "Timberline" }]));
    sessionLoaded.value = false;
    const claimed = useClaimedLists();
    claimed.restoreFromDevice();
    expect(claimed.lists.value.map((l) => l.title)).toEqual(["Timberline"]);
  });
});

describe("resumeHere — the bare address, both ways in, one gate", () => {
  it("ranks a claimed open only while the session hint is present", () => {
    markClaimedOpen("C0DE00000009");

    expect(resumeHere()).toEqual({ to: "/e/C0DE00000009", shareCode: "C0DE00000009" });

    // no hint: the route watcher would never ask the server, so the entry is
    // skipped — not forgotten — and the launch falls back to what the registry holds
    hasHint.value = false;
    expect(resumeHere()).toBeNull();
    expect(claimedOpens()).toHaveLength(1);
  });

  it("leaves the code a resume has just found dead out of the ranking", () => {
    markClaimedOpen("C0DE00000001");
    markClaimedOpen("C0DE00000009");

    expect(resumeHere("C0DE00000009")?.shareCode).toBe("C0DE00000001");
    expect(resumeHere("C0DE00000009")).not.toEqual(expect.objectContaining({ shareCode: "C0DE00000009" }));
  });

  it("leaves nothing of the account behind on sign-out", () => {
    storage.set(ROWS_KEY, JSON.stringify([{ shareCode: "C0DE00000009", title: "Timberline" }]));
    markClaimedOpen("C0DE00000009");

    useClaimedLists().resetClaimMark();

    expect(storage.has(ROWS_KEY)).toBe(false);
    expect(storage.has(OPENS_KEY)).toBe(false);
  });
});

describe("the claimed-opens ledger — where the bare address left off", () => {
  const at = (ms: number, run: () => void) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(ms);
      run();
    } finally {
      vi.useRealTimers();
    }
  };

  it("records an open and reads it back newest first", () => {
    at(1_000, () => markClaimedOpen("C0DE00000001"));
    at(2_000, () => markClaimedOpen("C0DE00000002"));

    expect(claimedOpens()).toEqual([
      { shareCode: "C0DE00000002", lastOpened: 2_000 },
      { shareCode: "C0DE00000001", lastOpened: 1_000 },
    ]);
  });

  it("re-stamps a list opened again, rather than keeping the first time", () => {
    at(1_000, () => markClaimedOpen("C0DE00000001"));
    at(2_000, () => markClaimedOpen("C0DE00000002"));
    at(3_000, () => markClaimedOpen("C0DE00000001"));

    expect(claimedOpens()[0]).toEqual({ shareCode: "C0DE00000001", lastOpened: 3_000 });
  });

  it("does not stamp with no account behind the browser", () => {
    // a tab still holding a claimed list open after a sign-out in another tab: the
    // shared cookie is gone, so its next sync must not re-create the ledger
    signedIn.value = false;
    sessionLoaded.value = true;
    hasHint.value = false;

    markClaimedOpen("C0DE00000001");

    expect(claimedOpens()).toEqual([]);
    expect(storage.has(OPENS_KEY)).toBe(false);
  });

  it("forgets one code, and reads a corrupt ledger as empty", () => {
    markClaimedOpen("C0DE00000001");
    forgetClaimedOpen("C0DE00000001");
    expect(claimedOpens()).toEqual([]);

    storage.set(OPENS_KEY, "{not json");
    expect(claimedOpens()).toEqual([]);
  });

  it("keeps only the most recent codes, so the device never accumulates them", () => {
    for (let i = 0; i < 40; i++) {
      at(1_000 + i, () => markClaimedOpen(`C0DE${String(i).padStart(8, "0")}`));
    }

    const opens = claimedOpens();
    expect(opens).toHaveLength(32);
    expect(opens[0]!.shareCode).toBe("C0DE00000039");
  });

  it("stops offering a list this account has been detached from", async () => {
    markClaimedOpen("C0DE00000009");

    await useClaimedLists().unclaim("C0DE00000009");

    expect(claimedOpens()).toEqual([]);
  });
});
