// The editor follows the account. A list opened THROUGH an account (share code +
// session, no edit link on this device) is that account's view of it, and signing in
// or out never navigates: a passkey in the account dialog finishes on the spot, and a
// sign-in in another tab changes the cookie under this one. The controller used to
// carry on with what it held: one account's unsent edits went out under the next
// account's session, its whole copy of the list was written into the next account's
// place on the device, and its gear was added to the next account's My Gear.
//
// The real editor, controller, session and device store run here. The server is the
// only double, and it answers for whoever its session says is signed in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSuspended, registerEndpoint } from "@nuxt/test-utils/runtime";
import { flushPromises, type VueWrapper } from "@vue/test-utils";
import { createError, getHeader, readBody, type H3Event } from "h3";
import { folder, gear, snapshotFor } from "./helpers/list";
import { stubLocalStorage } from "./helpers/storage";
import { accountSlot, claimedLocalKey, type LocalListRecord } from "~~/shared/localList";
import { LIST_CODE_HEADER } from "~~/shared/links";
import { vaultNormKey } from "~~/shared/vault";
import type { ListSnapshot } from "~~/shared/types";
import type { Op } from "~~/shared/ops";
import type { StampedOp } from "~~/shared/opStamp";
import { _setFlushBackoff, _setFlushDebounce } from "~/composables/useGearList";
import { _pendingCapture, _setCaptureDebounce } from "~/composables/useVault";
import GearEditor from "~/components/GearEditor.client.vue";

// IndexedDB's one request, over a Map: whose copy is whose is the real store's to
// decide. A request takes effect when it is made and answers on a later task, as
// IndexedDB's do, so one made in the answer to another comes after everything the
// page did in between.
const records = vi.hoisted(() => new Map<string, LocalListRecord>());
vi.mock("~~/shared/idb", () => ({
  idbRequest: async (_n: string, _v: number, _s: string, _m: string, run: (s: unknown) => { result: unknown }) => {
    const { result } = run({
      get: (k: string) => ({ result: structuredClone(records.get(k)) }),
      put: (v: LocalListRecord, k: string) => (records.set(k, structuredClone(v)), { result: k }),
      delete: (k: string) => (records.delete(k), { result: undefined }),
      getAllKeys: (range: { lower: string; upper: string }) => ({
        result: [...records.keys()].filter((k) => k >= range.lower && k <= range.upper),
      }),
    });
    await new Promise((r) => setTimeout(r));
    return result;
  },
}));
const storage = stubLocalStorage();

const CODE = "TESTC0DE0001";
const TOKEN = "an-edit-token-held-here";
const TENT = gear();
const TENT_KEY = vaultNormKey(TENT.brand, TENT.name, TENT.variant);
const fresh = (): ListSnapshot =>
  snapshotFor({ shareCode: CODE, slug: "alpine-loop-aaa111", title: "Alpine Loop", folders: [folder()], items: [TENT] });

// ---- the server: one list, and the accounts that hold it ---------------------------
let signedInAs: { owner: string; account: string } | null = null;
let holders = new Set<string>();
let serverList = fresh();
let down = false; // no network: nothing answers
/** Every request that carried the list's content, with the account it arrived as. */
let sent: { as: string | null; ops: Op[] }[] = [];
let captured: (string | null)[] = []; // whose My Gear was sent this list's gear
let asked: (string | null)[] = []; // who asked My Gear what it holds of this list
let opens = 0;
/** The edit link opens the list for anyone; the code opens it for an account that holds it. */
function allow(event: H3Event) {
  if (down) throw createError({ statusCode: 503, statusMessage: "Unreachable" });
  if (getHeader(event, "authorization") === `Bearer ${TOKEN}`) return;
  if (getHeader(event, LIST_CODE_HEADER) === CODE && signedInAs && holders.has(signedInAs.account)) return;
  throw createError({ statusCode: 401, statusMessage: "Missing edit capability" });
}
registerEndpoint("/api/auth/me", () => ({
  // each signed in on this browser, so the gear of the lists it holds is theirs to bank
  user: signedInAs && { ...signedInAs, email: `${signedInAs.account}@example.com`, displayName: null, sweep: true },
}));
registerEndpoint("/api/auth/signout", { method: "POST", handler: () => ((signedInAs = null), {}) });
registerEndpoint("/api/lists/claimed", () => ({ lists: [] }));
registerEndpoint("/api/edit/list", (event) => {
  allow(event);
  opens++;
  return { snapshot: serverList };
});
registerEndpoint("/api/edit/mutate", {
  method: "POST",
  handler: async (event) => {
    allow(event);
    const { ops = [] } = (await readBody<{ ops?: Op[] }>(event)) ?? {};
    sent.push({ as: signedInAs?.account ?? null, ops });
    // the one edit these cases make is a rename
    for (const op of ops) if (op.t === "setMeta") serverList = { ...serverList, title: op.patch.title ?? serverList.title };
    serverList = { ...serverList, version: serverList.version + 1 };
    return { snapshot: serverList };
  },
});
registerEndpoint("/api/edit/changes", (event) => (allow(event), { version: serverList.version }));
registerEndpoint("/api/catalog/use", () => ({}));
// My Gear: account A holds the tent, account B holds nothing
registerEndpoint("/api/vault/among", {
  method: "POST",
  handler: () => {
    asked.push(signedInAs?.account ?? null);
    return { keys: signedInAs?.account === "aaaa" ? [[TENT_KEY, TENT.unitWeightMg]] : [] };
  },
});
registerEndpoint("/api/vault/capture", { method: "POST", handler: () => (captured.push(signedInAs?.account ?? null), {}) });

// ---- the browser ---------------------------------------------------------------------
/** A sign-in finishing in this tab: the server's cookies, then its answer to the check. */
async function signIn(owner: string, account: string) {
  signedInAs = { owner, account };
  document.cookie = "mh_signed_in=1; path=/";
  document.cookie = `mh_session_owner=${owner}; path=/`;
  await useSession().refresh(true);
  expect(useSession().user.value?.account).toBe(account);
}
/** A sign-in finishing in ANOTHER tab: the cookies change under this one, and that tab's
 *  check leaves what it learned where both can read it. This tab is told nothing. */
function signInElsewhere(owner: string, account: string) {
  signedInAs = { owner, account };
  document.cookie = `mh_session_owner=${owner}; path=/`;
  storage.set(`gear.account.v1.${owner}`, account);
}
/** A sign-out in another tab: the cookies go, and what was kept for the session with them. */
function signOutElsewhere(owner: string) {
  signedInAs = null;
  document.cookie = "mh_signed_in=; Max-Age=0; path=/";
  document.cookie = "mh_session_owner=; Max-Age=0; path=/";
  storage.delete(`gear.account.v1.${owner}`);
}
const offline = () => ((down = true), window.dispatchEvent(new Event("offline")));
const online = () => ((down = false), window.dispatchEvent(new Event("online")));
const slot = (account: string) => records.get(accountSlot(claimedLocalKey(CODE), account));
const RENAME = { title: "Renamed by A" };
const renameOp: Op = { t: "setMeta", patch: RENAME };
/** Long enough for anything that was going to be sent or written to have been. */
const settle = () => new Promise((r) => setTimeout(r, 350));

let wrapper: VueWrapper | undefined;
async function openEditor(route: string) {
  wrapper = await mountSuspended(GearEditor, { route });
  const c = useGearList();
  await vi.waitFor(() => expect(c.status.value).toBe("synced"));
  return c;
}
/** A opens the list through the account, renames it with no network, and signs out from
 *  the account dialog with the rename unsent. Then the network is back. */
async function leftUnsentByA() {
  await signIn("1", "aaaa");
  const c = await openEditor(`/e/${CODE}`);
  offline();
  c.setMeta(RENAME);
  await vi.waitFor(() => expect(slot("aaaa")?.pending).toMatchObject([renameOp]));
  await useSession().signOut();
  online();
  return c;
}

beforeEach(() => {
  _setFlushDebounce(20);
  _setFlushBackoff(20);
  _setCaptureDebounce(20);
  vi.stubGlobal("indexedDB", {}); // the store stands down with no IndexedDB at all
  vi.stubGlobal("IDBKeyRange", { bound: (lower: string, upper: string) => ({ lower, upper }) });
  records.clear();
  storage.clear();
  serverList = fresh();
  holders = new Set(["aaaa", "bbbb"]);
  signedInAs = null;
  down = false;
  window.dispatchEvent(new Event("online"));
});
afterEach(async () => {
  wrapper?.unmount();
  wrapper = undefined;
  useGearList().dispose();
  signedInAs = null;
  await useSession().signOut();
  await flushPromises();
  await settle();
  sent = [];
  captured = [];
  asked = [];
  opens = 0;
  _setFlushDebounce();
  _setFlushBackoff();
  _setCaptureDebounce();
});

describe("a list opened through an account, when another account takes its place", () => {
  it("sends none of the first account's unsent edits as the next", async () => {
    const c = await leftUnsentByA();
    // B, who holds the list too, signs in with a passkey
    await signIn("2", "bbbb");
    await settle();

    expect(sent.filter((s) => s.as === "bbbb")).toEqual([]);
    // B is looking at the list as the server has it, opened for B
    expect(c.snapshot.value?.title).toBe("Alpine Loop");
    expect(slot("bbbb")).toMatchObject({ snapshot: { title: "Alpine Loop" }, pending: [] });
  });

  it("files nothing of the first account's in the next account's place on the device", async () => {
    await leftUnsentByA();
    // B does not hold this list at all, and leaves the page
    holders = new Set(["aaaa"]);
    await signIn("2", "bbbb");
    await settle();
    wrapper!.unmount();
    wrapper = undefined;
    await settle();

    expect(slot("bbbb")).toBeUndefined();
    // A's rename is still A's, on the device, for when A is back
    expect(slot("aaaa")?.pending).toMatchObject([renameOp]);
  });

  it("shows none of it to an account that does not hold the list", async () => {
    const c = await leftUnsentByA();
    holders = new Set(["aaaa"]);
    await signIn("2", "bbbb");
    await vi.waitFor(() => expect(c.status.value).toBe("missing"));
    expect(c.snapshot.value).toBeNull();
  });

  it("adds none of the first account's gear to the next account's My Gear", async () => {
    await signIn("1", "aaaa");
    await openEditor(`/e/${CODE}`);
    await useSession().signOut();
    captured = [];

    holders = new Set(["aaaa"]);
    await signIn("2", "bbbb");
    await settle();
    expect(captured).toEqual([]);
  });

  it("keeps what is typed after the session ended, for when its account is back", async () => {
    await signIn("1", "aaaa");
    const c = await openEditor(`/e/${CODE}`);
    await vi.waitFor(() => expect(slot("aaaa")).toBeDefined());

    // signed out in another tab; this one still has the list on screen
    signOutElsewhere("1");
    c.setMeta(RENAME);
    await settle();
    // not sent as nobody, and not lost with the tab either: it waits in A's copy
    expect(sent).toEqual([]);
    expect(slot("aaaa")?.pending).toMatchObject([renameOp]);

    // A signs back in, in a new session, and it is sent as A
    await signIn("3", "aaaa");
    await vi.waitFor(() => expect(sent).toMatchObject([{ as: "aaaa", ops: [renameOp] }]));
    await vi.waitFor(() => expect(c.snapshot.value?.title).toBe(RENAME.title));
  });

  it("does none of it when the other account signed in from another tab", async () => {
    await signIn("1", "aaaa");
    const c = await openEditor(`/e/${CODE}`);
    await vi.waitFor(() => expect(slot("aaaa")).toBeDefined());

    signInElsewhere("2", "bbbb");
    c.setMeta(RENAME); // typed in the tab A left open
    await settle();
    expect(sent).toEqual([]);
    expect(captured).toEqual([]);

    // this tab has found out who is signed in, and opened the list for them
    expect(useSession().user.value?.account).toBe("bbbb");
    await vi.waitFor(() => expect(slot("bbbb")).toBeDefined());
    expect(c.snapshot.value?.title).toBe("Alpine Loop");
    expect(slot("bbbb")).toMatchObject({ snapshot: { title: "Alpine Loop" }, pending: [] });
    expect(slot("aaaa")?.pending).toMatchObject([renameOp]);
  });
});

describe("a list opened through an account, when the same person comes and goes", () => {
  it("closes the list on a sign-out, and reopens it with nothing lost when they sign back in", async () => {
    const c = await leftUnsentByA();
    // signed out, the account's view of the list is off the screen
    await vi.waitFor(() => expect(c.snapshot.value).toBeNull());
    expect(c.status.value).toBe("missing");
    expect(slot("aaaa")?.pending).toMatchObject([renameOp]);

    await signIn("3", "aaaa");
    await vi.waitFor(() => expect(sent).toMatchObject([{ as: "aaaa", ops: [renameOp] }]));
    await vi.waitFor(() => expect(slot("aaaa")?.pending).toEqual([]));
    expect(c.snapshot.value?.title).toBe(RENAME.title);
  });

  it("carries on without loading again under a new session of the same account", async () => {
    await signIn("1", "aaaa");
    const c = await openEditor(`/e/${CODE}`);
    const opened = opens;
    const session = c.epochRef.value;

    await signIn("3", "aaaa");
    c.setMeta(RENAME);
    await vi.waitFor(() => expect(sent).toMatchObject([{ as: "aaaa", ops: [renameOp] }]));
    await vi.waitFor(() => expect(slot("aaaa")?.pending).toEqual([]));
    expect(c.epochRef.value).toBe(session);
    expect(opens).toBe(opened);
  });

  it("leaves no copy behind for an account that left with nothing unsent", async () => {
    await signIn("1", "aaaa");
    await openEditor(`/e/${CODE}`);
    await vi.waitFor(() => expect(slot("aaaa")).toBeDefined());

    await useSession().signOut();
    await settle();
    wrapper!.unmount();
    wrapper = undefined;
    await settle();
    expect(records.size).toBe(0);
  });

  // Two tabs on the list, one of them holding an edit it couldn't send. That tab signed
  // out and kept the edit in the account's place on the device. This one, with nothing
  // unsent of its own, closes its list when it finds out, and dropping its copy there
  // must not drop that one.
  it("leaves alone the edits another tab kept for the account when this one closes", async () => {
    await signIn("1", "aaaa");
    const c = await openEditor(`/e/${CODE}`);
    await vi.waitFor(() => expect(slot("aaaa")?.pending).toEqual([]));

    signOutElsewhere("1");
    const typedThere: StampedOp = { ...renameOp, from: "othertab", seq: 1 };
    const kept: LocalListRecord = {
      snapshot: { ...fresh(), title: RENAME.title },
      pending: [typedThere],
      updatedAt: Date.now(),
      account: "aaaa",
    };
    records.set(accountSlot(claimedLocalKey(CODE), "aaaa"), structuredClone(kept));

    await useSession().refresh(true); // this tab finds out: its poll, or coming back into view
    await vi.waitFor(() => expect(c.snapshot.value).toBeNull());
    await settle();
    expect(slot("aaaa")?.pending).toMatchObject([renameOp]);
  });

  it("leaves none behind either when the sign-out was in another tab and this page is then left", async () => {
    await signIn("1", "aaaa");
    await openEditor(`/e/${CODE}`);
    await vi.waitFor(() => expect(slot("aaaa")).toBeDefined());

    signOutElsewhere("1");
    records.clear(); // that tab dropped the account's copies as it signed out
    wrapper!.unmount(); // leaving the page writes the list down one last time
    wrapper = undefined;
    await new Promise((r) => setTimeout(r, 20));
    expect(records.size).toBe(0);
  });
});

describe("a list held by its edit link, when the account changes under it", () => {
  it("asks the new account's My Gear, rather than showing what the last account's holds", async () => {
    // "is this gear yours?" was answered no: nothing here is about the automatic capture
    storage.set(`gear.vault.answer.${CODE}`, "no");
    await signIn("1", "aaaa");
    const c = await openEditor(`/e/${CODE}#${TOKEN}`);
    await vi.waitFor(() => expect(c.vaultGear.value.has(TENT_KEY)).toBe(true)); // A has the tent
    asked = [];

    // B's sign-in replaces A's with nobody signed out in between
    await signIn("2", "bbbb");
    await vi.waitFor(() => expect(asked).toEqual(["bbbb"]));
    await vi.waitFor(() => expect(c.vaultGearSettled.value).toBe(true));
    expect(c.vaultGear.value.has(TENT_KEY)).toBe(false);
  });

  it("goes on sending under the link whoever is signed in, and never loads the list again", async () => {
    storage.set(`gear.vault.answer.${CODE}`, "no");
    await signIn("1", "aaaa");
    const c = await openEditor(`/e/${CODE}#${TOKEN}`);
    const opened = opens;
    offline();
    c.setMeta(RENAME);
    await vi.waitFor(() => expect(records.get(TOKEN)?.pending).toMatchObject([renameOp]));

    await useSession().signOut();
    online();
    await signIn("2", "bbbb");
    await vi.waitFor(() => expect(sent.flatMap((s) => s.ops)).toMatchObject([renameOp]));
    await vi.waitFor(() => expect(records.get(TOKEN)?.pending).toEqual([]));
    expect(opens).toBe(opened);
    expect(c.snapshot.value?.title).toBe(RENAME.title);
  });

  it("sends gear waiting to be added to one account's My Gear to no other account's", async () => {
    // a list this device made: its gear goes to My Gear without asking
    storage.set(`gear.vault.answer.${CODE}`, "yes");
    _setCaptureDebounce(150);
    await signIn("1", "aaaa");
    const c = await openEditor(`/e/${CODE}#${TOKEN}`);
    c.setMeta(RENAME);
    await vi.waitFor(() => expect(_pendingCapture()).toBe(true), { interval: 5 });

    // before it goes, another account signs in from another tab
    signInElsewhere("2", "bbbb");
    await settle();
    expect(captured).toEqual([]);
  });
});
