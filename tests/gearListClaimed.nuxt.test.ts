// The controller's CLAIMED-OPEN path: a list held by share code + session, with no
// edit token on this device (the phone side of "made on the Mac, opened on the
// phone"). Its own file rather than more cases in gearList.nuxt.test.ts because
// these endpoints must READ the auth headers — which capability a request carried
// is the thing under test — and registerEndpoint fixtures are file-global.
//
// What has to hold, and is pinned here:
//   • a code-open talks to the server with X-List-Code and NEVER a bearer;
//   • it is not a draft — editing it must never reach /api/lists/create (that
//     failure mode silently duplicates a real list);
//   • it never mints a device-registry row (the claimed switcher row is the
//     handle), and its on-device copy lives under the code: key;
//   • a rotate graduates it to the token path: bearer from then on, a registry
//     row minted, the code-keyed record gone;
//   • a rename reaches the claimed-lists state the switcher renders (touchByCode);
//   • it is stamped in the opens ledger, so the bare address — the installed app's
//     start_url, and therefore every offline launch — picks up here rather than at
//     whatever older list this device happens to hold an edit link for; a claim the
//     server refuses loses that stamp, but only once the session is known good.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { listEntry } from "./helpers/myLists";
import { snapshotFor as baseSnapshot } from "./helpers/list";
import { memoryListStore, quietVaultAccess } from "./helpers/gearList";
import { stubLocalStorage } from "./helpers/storage";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { createError, getHeader, readBody, type H3Event } from "h3";
import { claimedLocalKey, type LocalListRecord } from "~~/shared/localList";
import { LIST_CODE_HEADER } from "~~/shared/links";
import { resumeTarget } from "~~/shared/switcher";
import type { ListSnapshot } from "~~/shared/types";
import type { Op } from "~~/shared/ops";
import { _setFlushBackoff, _setFlushDebounce } from "~/composables/useGearList";

// ---- boundary stubs (same shape as gearList.nuxt.test.ts) ---------------------
// What is on the device. Most cases here reach it through the memory store; the ones
// about WHOSE copy it is ("two accounts at one browser") turn `real` on and run the
// real store over the same Map, with only IndexedDB's one request stubbed, because
// the filing by account is the store's and a double of it would be testing itself.
const device = vi.hoisted(() => ({ real: false, records: new Map<string, LocalListRecord>() }));
const records = device.records;
vi.mock("~~/shared/idb", () => ({
  idbRequest: async (_n: string, _v: number, _s: string, _m: string, run: (s: unknown) => { result: unknown }) =>
    run({
      get: (k: string) => ({ result: structuredClone(device.records.get(k)) }),
      put: (v: LocalListRecord, k: string) => (device.records.set(k, structuredClone(v)), { result: k }),
      delete: (k: string) => (device.records.delete(k), { result: undefined }),
      getAllKeys: (range: { lower: string; upper: string }) => ({
        result: [...device.records.keys()].filter((k) => k >= range.lower && k <= range.upper),
      }),
    }).result,
}));
mockNuxtImport<typeof useLocalListStore>("useLocalListStore", (original) => () => {
  // chosen at each call, not once: the controller keeps the store it was made with
  const now = () => (device.real ? original() : memoryListStore(records));
  return {
    get: (key) => now().get(key),
    set: (key, record) => now().set(key, record),
    del: (key) => now().del(key),
    delClaimed: () => now().delClaimed(),
    prefetch: (key) => now().prefetch(key),
    take: (key) => now().take(key),
  };
});
// the vault is not this file's subject: no vault, and the session answered, so
// capture stays quiet and its reads settle instead of waiting
mockNuxtImport("useVaultAccess", () => () => quietVaultAccess());

const storage = stubLocalStorage();

// every edit here waits out the flush debounce; 450 ms of it is not the subject
_setFlushDebounce(20);

// ---- the network, capability-aware ---------------------------------------------
const CODE = "TESTC0DE0001"; // canonical Crockford — normalizes to itself
const snapshotFor = (title: string, version = 1): ListSnapshot =>
  baseSnapshot({ shareCode: CODE, slug: "claimed-list-aaa111", title, version });

interface SeenAuth {
  bearer: string | undefined;
  listCode: string | undefined;
}
const authOf = (event: H3Event): SeenAuth => ({
  bearer: getHeader(event, "authorization"),
  listCode: getHeader(event, LIST_CODE_HEADER),
});

let listAuth: SeenAuth[] = [];
let serverList: ListSnapshot = snapshotFor("Alpine Loop");
// When set, the open is refused the way editAuth refuses a lapsed session or an
// unclaimed code — the client-side half of that contract is a test below.
let refuseOpens = false;
// When set, the server is simply not there: the shape of an OFFLINE open, which the
// controller tells apart from a refusal (no 401/404 → "offline", never "missing").
let failOpens = false;
// When set, that answer waits, so a case can put two requests in the order it needs.
let openHeld: Promise<void> | null = null;
let mutateHeld: Promise<void> | null = null;
let refuseMutates = false;
// When set, an edit never reaches the server: a device with no network.
let failMutates = false;
registerEndpoint("/api/edit/list", async (event) => {
  listAuth.push(authOf(event));
  if (openHeld) await openHeld;
  if (refuseOpens) throw createError({ statusCode: 401, statusMessage: "Missing edit capability" });
  if (failOpens) throw createError({ statusCode: 503, statusMessage: "Unreachable" });
  return { snapshot: serverList };
});

// Who the server says is signed in, for the cases that sign accounts in and out for
// real ("two accounts at one browser"); nobody, until one of them says otherwise.
let signedInAs: { owner: string; account: string } | null = null;
registerEndpoint("/api/auth/me", () => ({
  user: signedInAs && { ...signedInAs, email: "someone@example.com", displayName: null, sweep: false },
}));
registerEndpoint("/api/auth/signout", { method: "POST", handler: () => ((signedInAs = null), {}) });

// The session, as the controller reads it for the 401 verdict below. The real
// composable runs here (nothing mocks it), so its state is set the way /api/auth/me
// would leave it.
function sessionResolved(signedIn: boolean) {
  useState<unknown>("session").value = signedIn
    ? { state: "signedIn", user: { owner: "1", email: "ryan@example.com", displayName: null } }
    : { state: "signedOut" };
}
function sessionUnresolved() {
  useState<unknown>("session").value = { state: "unresolved" };
}

let mutateAuth: (SeenAuth & { ops?: Op[] })[] = [];
registerEndpoint("/api/edit/mutate", {
  method: "POST",
  handler: async (event) => {
    const seen: SeenAuth & { ops?: Op[] } = authOf(event);
    mutateAuth.push(seen);
    if (failMutates) throw createError({ statusCode: 503, statusMessage: "Unreachable" });
    const body = await readBody<{ ops?: Op[] }>(event);
    seen.ops = body?.ops;
    if (mutateHeld) await mutateHeld;
    if (refuseMutates) throw createError({ statusCode: 401, statusMessage: "Missing edit capability" });
    // echo the ops onto the snapshot the way the reducer would for the one op
    // these tests send (setMeta: a title, a description), so the controller adopts
    // a truthful merge
    for (const op of body?.ops ?? []) {
      if (op.t !== "setMeta") continue;
      const { title = serverList.title, description = serverList.description } = op.patch;
      serverList = { ...serverList, title, description };
    }
    serverList = { ...serverList, version: serverList.version + 1 };
    return { snapshot: serverList };
  },
});

registerEndpoint("/api/edit/changes", () => ({ version: serverList.version }));
registerEndpoint("/api/catalog/use", () => ({}));

const ROTATED_TOKEN = "rotated-edit-token";
let rotateAuth: SeenAuth[] = [];
registerEndpoint("/api/edit/rotate", {
  method: "POST",
  handler: (event) => {
    rotateAuth.push(authOf(event));
    return { editToken: ROTATED_TOKEN };
  },
});

// The tripwire. A claimed open that ever falls into the draft path creates a
// second list out of a real one — the exact hazard dispatch()'s guard exists for.
let createCalls = 0;
registerEndpoint("/api/lists/create", {
  method: "POST",
  handler: () => {
    createCalls++;
    return { editToken: "never-minted", snapshot: snapshotFor("Duplicate") };
  },
});

const flushed = () =>
  vi.waitFor(() => expect(mutateAuth.length).toBeGreaterThan(0), { timeout: 5_000, interval: 25 });

describe("useGearList — a claimed open (share code + session, no token held)", () => {
  beforeEach(() => {
    records.clear();
    storage.clear();
    listAuth = [];
    mutateAuth = [];
    rotateAuth = [];
    createCalls = 0;
    serverList = snapshotFor("Alpine Loop");
    useMyLists().entries.value = [];
    useClaimedLists().lists.value = [
      { shareCode: CODE, slug: "claimed-list-aaa111", title: "Alpine Loop", totalMg: 0, version: 1, displayUnit: "g", updatedAt: "2026-08-07T00:00:00.000Z" },
    ];
    sessionUnresolved();
    // a claimed open only ever happens with the session hint present (the route
    // watcher's gate), and the ledger stamps only with an account behind the browser
    document.cookie = "mh_signed_in=1; path=/";
    document.cookie = "mh_session_owner=1; path=/";
    window.dispatchEvent(new Event("online"));
  });
  afterEach(() => {
    useGearList().dispose();
  });

  it("opens with X-List-Code and no bearer, and adopts the server snapshot", async () => {
    const c = useGearList();
    await c.load({ code: CODE });

    expect(listAuth).toHaveLength(1);
    expect(listAuth[0]).toEqual({ bearer: undefined, listCode: CODE });
    expect(c.snapshot.value?.title).toBe("Alpine Loop");
    expect(c.status.value).toBe("synced");
    expect(c.openedByCode.value).toBe(true);
    expect(c.editToken).toBe("");
  });

  it("normalizes a sloppy code once, everywhere: header, storage key, state", async () => {
    const c = useGearList();
    // lowercase with O for 0 — what a hand-typed /e/{code} URL can deliver
    await c.load({ code: CODE.toLowerCase().replace(/0/g, "o") });

    expect(listAuth[0]!.listCode).toBe(CODE);
    c.setMeta({ title: "Renamed" });
    await vi.waitFor(() => expect(records.has(claimedLocalKey(CODE))).toBe(true));
  });

  it("never registers a device row — the claimed switcher row is the handle", async () => {
    const c = useGearList();
    await c.load({ code: CODE });
    expect(useMyLists().entries.value).toHaveLength(0);
  });

  it("is still where the bare address picks up, registry row or not", async () => {
    // The bug: with no row to stamp, an open through the account left nothing the
    // resume could rank, so the installed app launched into some other list — one
    // this device held a token for and you hadn't touched in weeks.
    useMyLists().entries.value = [
      listEntry({ editToken: "older-token", shareCode: "0LDLIST00001", slug: "older-list-bbb222", title: "Older" }),
    ];

    const c = useGearList();
    await c.load({ code: CODE });

    expect(claimedOpens()[0]?.shareCode).toBe(CODE);
    expect(resumeTarget(useMyLists().entries.value, claimedOpens())).toEqual({
      to: `/e/${CODE}`,
      shareCode: CODE,
    });
  });

  it("stamps the ledger on an OFFLINE open, hydrated from the on-device copy", async () => {
    // no server to confirm anything, and still every bit "the list you had open"
    records.set(claimedLocalKey(CODE), {
      snapshot: snapshotFor("Alpine Loop"),
      pending: [],
      updatedAt: 1,
    });
    failOpens = true;
    try {
      const c = useGearList();
      await c.load({ code: CODE });
      expect(c.status.value).toBe("offline");
      expect(claimedOpens()[0]?.shareCode).toBe(CODE);
    } finally {
      failOpens = false;
    }
  });

  it("with no copy on the device and no network, waits as offline and loads itself when the network returns", async () => {
    // the installed app launched in a tunnel to a list this device never opened:
    // nothing to hydrate, nothing to fetch — say so, and load when the network is back
    window.dispatchEvent(new Event("offline"));
    failOpens = true;
    try {
      const c = useGearList();
      await c.load({ code: CODE });
      expect(c.status.value).toBe("offline");
      expect(c.snapshot.value).toBeNull();

      failOpens = false;
      window.dispatchEvent(new Event("online"));
      await vi.waitFor(() => expect(c.snapshot.value?.title).toBe("Alpine Loop"));
      expect(c.status.value).toBe("synced");
    } finally {
      failOpens = false;
      window.dispatchEvent(new Event("online"));
    }
  });

  it("with no copy and a server that does not answer, says so and can try again", async () => {
    failOpens = true;
    try {
      const c = useGearList();
      await c.load({ code: CODE });
      expect(c.status.value).toBe("error");
      expect(c.snapshot.value).toBeNull();

      failOpens = false;
      c.retryLoad();
      await vi.waitFor(() => expect(c.status.value).toBe("synced"));
      expect(c.snapshot.value?.title).toBe("Alpine Loop");
    } finally {
      failOpens = false;
    }
  });

  it("a claim the server refuses loses its stamp — once the session is known good", async () => {
    // The hydrate path stamps before the server answers; a 401 with the session
    // resolved signed-in can only mean the CLAIM is dead (unclaimed or deleted on
    // another device), and the bare address must stop offering to resume it.
    records.set(claimedLocalKey(CODE), { snapshot: snapshotFor("Alpine Loop"), pending: [], updatedAt: 1 });
    sessionResolved(true);
    refuseOpens = true;
    try {
      const c = useGearList();
      await c.load({ code: CODE });
      expect(c.status.value).toBe("missing");
      expect(claimedOpens()).toEqual([]);
      // ...and the dead-end page cannot stamp it back: device-only edits there
      // sync the row copy but leave the ledger alone
      c.setMeta({ title: "Typed on the dead-end" });
      expect(claimedOpens()).toEqual([]);
    } finally {
      refuseOpens = false;
    }
  });

  it("a refused claim keeps its stamp while the session is unresolved", async () => {
    // A 401 on a claimed open is "no claim under this session" — with the session
    // itself unanswered (offline, or still being asked) that is as likely the session
    // as the claim, and forgetting on it lost where you left off for a list the
    // account still holds.
    records.set(claimedLocalKey(CODE), { snapshot: snapshotFor("Alpine Loop"), pending: [], updatedAt: 1 });
    sessionUnresolved();
    refuseOpens = true;
    try {
      const c = useGearList();
      await c.load({ code: CODE });
      expect(c.status.value).toBe("missing");
      expect(claimedOpens()[0]?.shareCode).toBe(CODE);
    } finally {
      refuseOpens = false;
    }
  });

  it("a token confirming the same list drops its ledger twin", async () => {
    // Opened through the account once (ledger), then through the edit link: the row
    // is the way in from now on, and a ledger entry would only resurface — ranked at
    // the older time — the moment the row is deleted or removed from this device.
    markClaimedOpen(CODE);
    const c = useGearList();
    await c.load({ token: "held-token" });

    expect(useMyLists().entries.value.map((e) => e.shareCode)).toEqual([CODE]);
    expect(claimedOpens()).toEqual([]);
  });

  it("edits flush through the code header and NEVER reach the draft-create path", async () => {
    const c = useGearList();
    await c.load({ code: CODE });
    c.setMeta({ title: "Renamed on the phone" });

    await flushed();
    expect(mutateAuth[0]).toMatchObject({ bearer: undefined, listCode: CODE });
    // the hazard case: a code-open mistaken for a draft would have minted a
    // duplicate list here instead of (or as well as) mutating the real one
    expect(createCalls).toBe(0);
    await vi.waitFor(() => expect(c.status.value).toBe("synced"));
    expect(c.snapshot.value?.version).toBe(2);
  });

  it("mirrors a rename onto the claimed row the switcher reads", async () => {
    const c = useGearList();
    await c.load({ code: CODE });
    c.setMeta({ title: "Wind River Loop" });

    // the optimistic mirror lands with the dispatch, before any round-trip
    expect(useClaimedLists().lists.value[0]!.title).toBe("Wind River Loop");
    await flushed();
  });

  it("keeps the on-device copy under the code: key, queue included", async () => {
    const c = useGearList();
    await c.load({ code: CODE });
    c.setMeta({ title: "Persisted" });

    await vi.waitFor(() => {
      const rec = records.get(claimedLocalKey(CODE));
      expect(rec?.snapshot.title).toBe("Persisted");
    });
    // and nothing landed under the draft slot or any token-shaped key
    expect([...records.keys()]).toEqual([claimedLocalKey(CODE)]);
  });

  it("a refused open lands in the missing dead-end — not a draft, no create", async () => {
    // What a lapsed session or a revoked claim looks like from here: the same
    // bare 401 editAuth sends for both (editAuthGate.test.ts pins that side).
    refuseOpens = true;
    try {
      const c = useGearList();
      await c.load({ code: CODE });
      expect(c.status.value).toBe("missing");
      expect(c.openedByCode.value).toBe(true); // the dead-end can say WHY (see GearEditor)
      expect(createCalls).toBe(0);
      expect(useMyLists().entries.value).toHaveLength(0);
    } finally {
      refuseOpens = false;
    }
  });

  // "missing" is the server's verdict, and the network can't change it: a list that read
  // as merely offline for the length of a dropped connection took the dead-end's frank
  // wording down with it, and came back to re-fire everything that watches for the verdict.
  it("stays missing through a dropped connection, with a copy on screen", async () => {
    records.set(claimedLocalKey(CODE), { snapshot: snapshotFor("Alpine Loop"), pending: [], updatedAt: 1 });
    sessionResolved(true);
    refuseOpens = true;
    try {
      const c = useGearList();
      await c.load({ code: CODE });
      expect(c.snapshot.value).not.toBeNull();
      expect(c.status.value).toBe("missing");

      window.dispatchEvent(new Event("offline"));
      await nextTick();
      expect(c.status.value).toBe("missing");

      window.dispatchEvent(new Event("online"));
      await nextTick();
      expect(c.status.value).toBe("missing");
    } finally {
      refuseOpens = false;
      window.dispatchEvent(new Event("online"));
    }
  });

  // A copy on the device is editable before the server has answered for it, so a load
  // and a flush overlap. Only a 404 is a verdict from a flush; a refused mutate answering
  // after the open was refused must not read as the list having come back, which started
  // the retries, the queue and the ledger stamp all over again.
  it("stays missing when a flush answers after the open was refused", async () => {
    records.set(claimedLocalKey(CODE), { snapshot: snapshotFor("Alpine Loop"), pending: [], updatedAt: 1 });
    sessionResolved(true);
    _setFlushBackoff(5);
    refuseOpens = true;
    refuseMutates = true;
    let answerOpen = () => {};
    let answerMutate = () => {};
    openHeld = new Promise((r) => (answerOpen = r));
    mutateHeld = new Promise((r) => (answerMutate = r));
    try {
      const c = useGearList();
      const opened = c.load({ code: CODE });
      await vi.waitFor(() => expect(c.snapshot.value).not.toBeNull());
      c.setMeta({ title: "Typed before the answer" });
      await vi.waitFor(() => expect(mutateAuth).toHaveLength(1));

      answerOpen();
      await opened;
      expect(c.status.value).toBe("missing");
      answerMutate();
      await new Promise((r) => setTimeout(r, 60));
      expect(c.status.value).toBe("missing");
      expect(mutateAuth).toHaveLength(1);

      c.setMeta({ title: "Typed after it" });
      await new Promise((r) => setTimeout(r, 60));
      expect(mutateAuth).toHaveLength(1);
      expect(claimedOpens()).toEqual([]);
    } finally {
      _setFlushBackoff();
      refuseOpens = false;
      refuseMutates = false;
      openHeld = null;
      mutateHeld = null;
    }
  });

  it("names what an open holds, one way in at a time", async () => {
    const c = useGearList();
    c.startKeyless(CODE);
    expect(c.keylessCode.value).toBe(CODE);
    expect(c.openedByCode.value).toBe(false);

    await c.load({ code: CODE });
    expect(c.keylessCode.value).toBe("");
    expect(c.openedByCode.value).toBe(true);
    expect(c.claimCode).toBe(CODE);

    // the token is the stronger claim, on both paths in
    await c.load({ token: "a-token", code: CODE });
    expect(c.editToken).toBe("a-token");
    expect(c.claimCode).toBe("");
    expect(c.openedByCode.value).toBe(false);

    c.dispose();
    expect(c.editToken).toBe("");
    expect(c.claimCode).toBe("");
  });

  it("rotate graduates the open to the token path and re-keys everything", async () => {
    const c = useGearList();
    await c.load({ code: CODE });
    c.setMeta({ title: "Before rotate" });
    await flushed();
    // the editor's edit link is a computed over this, and must follow a rotate
    const tracked = computed(() => c.editToken);
    expect(tracked.value).toBe("");

    const next = await c.rotate();
    expect(next).toBe(ROTATED_TOKEN);
    // the rotate itself went out on the code — the last act of the session path
    expect(rotateAuth[0]).toEqual({ bearer: undefined, listCode: CODE });
    expect(c.openedByCode.value).toBe(false);
    expect(c.editToken).toBe(ROTATED_TOKEN);
    expect(tracked.value).toBe(ROTATED_TOKEN);
    // a claimed open never asks whose the gear is (it's the account's); holding the
    // link instead must not start asking
    expect(c.vaultAuto.value).toBe(true);

    // the device now holds the capability: a registry row exists…
    const rows = useMyLists().entries.value;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ editToken: ROTATED_TOKEN, shareCode: CODE });
    // …the code-keyed record is gone, and the copy re-keys onto the token
    await vi.waitFor(() => {
      expect(records.has(claimedLocalKey(CODE))).toBe(false);
      expect(records.has(ROTATED_TOKEN)).toBe(true);
    });
    // …and so is the ledger entry: the registry row is the way back in from here,
    // and resumeTarget skips a claimed entry the registry already covers anyway
    expect(claimedOpens()).toEqual([]);

    // and the next edit carries the new token instead of naming the claim
    mutateAuth = [];
    c.setMeta({ title: "After rotate" });
    await vi.waitFor(() => expect(mutateAuth).toHaveLength(1));
    expect(mutateAuth[0]).toMatchObject({
      bearer: `Bearer ${ROTATED_TOKEN}`,
      listCode: undefined,
      ops: [{ t: "setMeta", patch: { title: "After rotate" } }],
    });
  });

  // A list two accounts both hold, opened through each of them at one browser. The
  // real store and the real session run here: which copy is whose is theirs to decide.
  describe("two accounts at one browser", () => {
    beforeEach(() => {
      device.real = true;
      // the store stands down where there is no IndexedDB at all, and this environment has none
      vi.stubGlobal("indexedDB", {});
      vi.stubGlobal("IDBKeyRange", { bound: (lower: string, upper: string) => ({ lower, upper }) });
      signedInAs = null;
      failMutates = false;
    });
    afterEach(() => {
      device.real = false;
      vi.stubGlobal("indexedDB", undefined);
      failMutates = false;
      signedInAs = null;
    });

    // A sign-in as the server leaves it: the two readable cookies, and its answer
    // to the session check that follows.
    async function signIn(owner: string, account: string) {
      signedInAs = { owner, account };
      document.cookie = "mh_signed_in=1; path=/";
      document.cookie = `mh_session_owner=${owner}; path=/`;
      await useSession().refresh(true);
      expect(useSession().user.value?.account).toBe(account);
    }
    // Leaving the way the menu does, with the list still on screen; then the page goes.
    async function signOut(c: ReturnType<typeof useGearList>) {
      await useSession().signOut();
      c.dispose();
    }
    async function open() {
      const c = useGearList();
      await c.load({ code: CODE });
      return c;
    }
    /** The signed-in account's copy of the list, as the store hands it over. */
    const onDevice = () => useLocalListStore().get(claimedLocalKey(CODE));
    /** Everything sent, acknowledged, and written down as sent. */
    async function settled(c: ReturnType<typeof useGearList>) {
      await vi.waitFor(() => expect(c.status.value).toBe("synced"));
      await vi.waitFor(async () => expect((await onDevice())?.pending).toEqual([]));
    }
    /** The edits the server was sent, in order. */
    const sent = () => mutateAuth.flatMap((m) => m.ops ?? []).map((op) => (op.t === "setMeta" ? op.patch : op));
    const RENAME = { title: "Renamed by A, offline" };
    const NOTE = { description: "Noted by B" };

    it("keeps one account's unsent edits through another account opening the same list", async () => {
      // A opens the list, loses the network, renames it, and signs out with the
      // rename still unsent
      await signIn("1", "aaaa");
      let c = await open();
      window.dispatchEvent(new Event("offline"));
      failMutates = true;
      c.setMeta(RENAME);
      await vi.waitFor(async () => expect((await onDevice())?.pending).toHaveLength(1));
      await signOut(c); // the page's parting send finds no network either
      await vi.waitFor(() => expect(mutateAuth).toHaveLength(1));

      // B, who holds the list too, signs in here and opens it with the network back
      window.dispatchEvent(new Event("online"));
      failMutates = false;
      mutateAuth = [];
      await signIn("2", "bbbb");
      c = await open();
      // B is shown the server's list, never what A typed and didn't send
      expect(c.snapshot.value?.title).toBe("Alpine Loop");
      c.setMeta(NOTE);
      await vi.waitFor(() => expect(sent()).toEqual([NOTE]));
      // ...and has a copy of its own on the device, the way any open does
      await settled(c);
      expect((await onDevice())?.snapshot.description).toBe(NOTE.description);
      await signOut(c);

      // A comes back, in a new session: the rename is still here, and is sent
      mutateAuth = [];
      await signIn("3", "aaaa");
      const waiting = records.size; // what B's leaving left on the device
      c = await open();
      await vi.waitFor(() => expect(sent()).toEqual([RENAME]));
      await settled(c);
      expect(c.snapshot.value).toMatchObject({ ...RENAME, ...NOTE }); // beside B's change
      // B's copy went when B left, with nothing unsent in it; A's was the one waiting,
      // and goes the same way now that it has been sent
      expect(waiting).toBe(1);
      await signOut(c);
      await vi.waitFor(() => expect(records.size).toBe(0));
    });

    it("finds a copy kept before each account had its own, for its account and no other", async () => {
      // as the device held it then: under the list's own key, stamped for A, a rename unsent
      records.set(claimedLocalKey(CODE), {
        snapshot: snapshotFor(RENAME.title),
        pending: [{ t: "setMeta", patch: RENAME }],
        updatedAt: 1,
        account: "aaaa",
      });

      await signIn("2", "bbbb");
      let c = await open();
      expect(c.snapshot.value?.title).toBe("Alpine Loop");
      c.setMeta(NOTE);
      await vi.waitFor(() => expect(sent()).toEqual([NOTE]));
      await settled(c);
      await signOut(c);

      mutateAuth = [];
      await signIn("3", "aaaa");
      c = await open();
      await vi.waitFor(() => expect(sent()).toEqual([RENAME]));
      await settled(c);
      expect(c.snapshot.value).toMatchObject({ ...RENAME, ...NOTE });
      // moved to A's own, not copied: nothing is left to be sent a second time
      await signOut(c);
      await vi.waitFor(() => expect(records.size).toBe(0));
    });
  });
});
