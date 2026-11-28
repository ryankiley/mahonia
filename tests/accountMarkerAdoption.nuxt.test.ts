// The account marker changed: it was a hash of the account's id and address, and is
// now random and stored (tests/accountMarker.test.ts has the server's half). A browser
// files a list opened through an account under that marker, unsent edits and all, so
// the edits a person typed offline before the change are filed under a marker the
// account no longer goes by. For a while the server answers both, and this is what the
// app does with them: the account's copy is found wherever it was filed, moved to
// where it is filed now, and sent, and a list already open is not closed for it.
//
// The real editor, controller, session and device store run here. The server is the
// only double.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSuspended, registerEndpoint } from "@nuxt/test-utils/runtime";
import { flushPromises, type VueWrapper } from "@vue/test-utils";
import { createError, getHeader, readBody, type H3Event } from "h3";
import { folder, gear, snapshotFor } from "./helpers/list";
import { stubLocalStorage } from "./helpers/storage";
import { accountSlot, claimedLocalKey, type LocalListRecord } from "~~/shared/localList";
import { LIST_CODE_HEADER } from "~~/shared/links";
import type { ListSnapshot } from "~~/shared/types";
import type { Op } from "~~/shared/ops";
import { _setFlushBackoff, _setFlushDebounce } from "~/composables/useGearList";
import GearEditor from "~/components/GearEditor.client.vue";

// IndexedDB's one request, over a Map (as tests/editorFollowsAccount.nuxt.test.ts):
// whose copy is whose is the real store's to decide.
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
const fresh = (): ListSnapshot =>
  snapshotFor({ shareCode: CODE, slug: "alpine-loop-aaa111", title: "Alpine Loop", folders: [folder()], items: [gear()] });

// ---- the server: one list, two accounts that hold it, each with two markers -------
interface Account {
  name: string;
  /** the marker it went by before: what an app shell from before filed under */
  was: string;
  /** the stored one */
  now: string;
}
const A: Account = { name: "A", was: "aaaa", now: "a1a1" };
const B: Account = { name: "B", was: "bbbb", now: "b1b1" };
/** Which server answers: one from before the stored marker, the one that answers both,
 *  or one from after the former marker is gone. */
let server: "before" | "both" | "after" = "both";
let signedInAs: { owner: string; who: Account } | null = null;
let meHeld: Promise<void> | null = null; // the session check waits for this
let serverList = fresh();
let down = false;
/** Every request that carried the list's content, with the account it arrived as. */
let sent: { as: string | null; ops: Op[] }[] = [];
let opens = 0;
function allow(event: H3Event) {
  if (down) throw createError({ statusCode: 503, statusMessage: "Unreachable" });
  if (getHeader(event, LIST_CODE_HEADER) === CODE && signedInAs) return;
  throw createError({ statusCode: 401, statusMessage: "Missing edit capability" });
}
registerEndpoint("/api/auth/me", async () => {
  if (meHeld) await meHeld;
  if (!signedInAs) return { user: null };
  const { owner, who } = signedInAs;
  const markers =
    server === "before" ? { account: who.was }
      : server === "both" ? { account: who.was, accountNow: who.now }
        : { account: who.now };
  return { user: { owner, email: `${who.name}@example.com`, displayName: null, sweep: false, ...markers } };
});
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
    sent.push({ as: signedInAs?.who.name ?? null, ops });
    // the edits these cases make: a rename, a note
    for (const op of ops) {
      if (op.t !== "setMeta") continue;
      const { title = serverList.title, description = serverList.description } = op.patch;
      serverList = { ...serverList, title, description };
    }
    serverList = { ...serverList, version: serverList.version + 1 };
    return { snapshot: serverList };
  },
});
registerEndpoint("/api/edit/changes", (event) => (allow(event), { version: serverList.version }));
registerEndpoint("/api/catalog/use", () => ({}));
registerEndpoint("/api/vault/among", { method: "POST", handler: () => ({ keys: [] }) });
registerEndpoint("/api/vault/capture", { method: "POST", handler: () => ({}) });

// ---- the browser ---------------------------------------------------------------------
/** The cookies a sign-in leaves, with nothing asked yet. */
function cookiesFor(owner: string, who: Account) {
  signedInAs = { owner, who };
  document.cookie = "mh_signed_in=1; path=/";
  document.cookie = `mh_session_owner=${owner}; path=/`;
}
/** A sign-in finishing in this tab: the server's cookies, then its answer to the check. */
async function signIn(owner: string, who: Account) {
  cookiesFor(owner, who);
  await useSession().refresh(true);
  return useSession().user.value;
}
const slot = (marker: string) => records.get(accountSlot(claimedLocalKey(CODE), marker));
const RENAME = { title: "Renamed offline" };
const NOTE = { description: "Noted later" };
const renameOp: Op = { t: "setMeta", patch: RENAME };
const noteOp: Op = { t: "setMeta", patch: NOTE };
/** The list as a browser kept it with a rename typed offline and never sent. */
const renamedUnsent = (account?: string): LocalListRecord => ({
  snapshot: { ...fresh(), ...RENAME },
  pending: [renameOp],
  updatedAt: 1,
  ...(account ? { account } : {}),
});
/** Every edit the server was sent, in order, with who it arrived as. */
const arrived = () => sent.flatMap((s) => s.ops.map((op) => ({ as: s.as, op })));
/** Long enough for anything that was going to be sent or written to have been. */
const settle = () => new Promise((r) => setTimeout(r, 350));

let wrapper: VueWrapper | undefined;
async function openEditor() {
  wrapper = await mountSuspended(GearEditor, { route: `/e/${CODE}` });
  const c = useGearList();
  await vi.waitFor(() => expect(c.status.value).toBe("synced"));
  return c;
}
/** Leave the page, as a navigation away does: the list is written down one last time. */
async function leave() {
  wrapper?.unmount();
  wrapper = undefined;
  await settle();
}

beforeEach(() => {
  _setFlushDebounce(20);
  _setFlushBackoff(20);
  vi.stubGlobal("indexedDB", {}); // the store stands down with no IndexedDB at all
  vi.stubGlobal("IDBKeyRange", { bound: (lower: string, upper: string) => ({ lower, upper }) });
  records.clear();
  storage.clear();
  serverList = fresh();
  server = "both";
  signedInAs = null;
  meHeld = null;
  down = false;
  window.dispatchEvent(new Event("online"));
});
afterEach(async () => {
  wrapper?.unmount();
  wrapper = undefined;
  useGearList().dispose();
  signedInAs = null;
  meHeld = null;
  await useSession().signOut();
  await flushPromises();
  await settle();
  sent = [];
  opens = 0;
  _setFlushDebounce();
  _setFlushBackoff();
});

describe("unsent edits filed under the marker an account went by before", () => {
  it("are taken over and sent the first time the account opens the list", async () => {
    records.set(accountSlot(claimedLocalKey(CODE), A.was), renamedUnsent(A.was));

    expect(await signIn("1", A)).toMatchObject({ account: A.now });
    const c = await openEditor();

    await vi.waitFor(() => expect(arrived()).toMatchObject([{ as: "A", op: renameOp }]));
    expect(c.snapshot.value?.title).toBe(RENAME.title);
    // moved, not copied: filed where the account files now, and nowhere else
    await vi.waitFor(() => expect(slot(A.now)).toMatchObject({ account: A.now, pending: [] }));
    expect(slot(A.was)).toBeUndefined();
    expect(records.size).toBe(1);
  });

  it("wait through another account's turn at the browser, and are never that account's", async () => {
    records.set(accountSlot(claimedLocalKey(CODE), A.was), renamedUnsent(A.was));

    // B, who holds the list too, signs in, opens it and signs out
    await signIn("2", B);
    const c = await openEditor();
    expect(c.snapshot.value?.title).toBe("Alpine Loop");
    await vi.waitFor(() => expect(slot(B.now)).toBeDefined());
    await useSession().signOut();
    await vi.waitFor(() => expect(c.status.value).toBe("missing"));
    await settle();
    expect(sent).toEqual([]);
    expect(slot(B.now)).toBeUndefined();
    expect(slot(A.was)?.pending).toMatchObject([renameOp]);

    // A is back, in a new session, and the page opens the list for A
    await signIn("3", A);
    await vi.waitFor(() => expect(arrived()).toMatchObject([{ as: "A", op: renameOp }]));
    await vi.waitFor(() => expect(slot(A.now)?.pending).toEqual([]));
    expect(slot(A.was)).toBeUndefined();
  });

  it("are found in a copy from before each account had a place of its own, too", async () => {
    records.set(claimedLocalKey(CODE), renamedUnsent(A.was));

    await signIn("2", B);
    const c = await openEditor();
    expect(c.snapshot.value?.title).toBe("Alpine Loop");
    await useSession().signOut();
    await vi.waitFor(() => expect(c.status.value).toBe("missing"));
    await settle();
    expect(sent).toEqual([]);

    await signIn("3", A);
    await vi.waitFor(() => expect(arrived()).toMatchObject([{ as: "A", op: renameOp }]));
    await vi.waitFor(() => expect(slot(A.now)?.pending).toEqual([]));
    expect(records.size).toBe(1);
  });

  // Two copies of one account's: another tab still on the shell from before writes
  // where it always did, and the account's own place already holds what this shell
  // loaded. The one with something unsent in it is the one worth having.
  it("are taken over where the account already has a copy with nothing unsent in it", async () => {
    records.set(accountSlot(claimedLocalKey(CODE), A.now), { snapshot: fresh(), pending: [], updatedAt: 2, account: A.now });
    records.set(accountSlot(claimedLocalKey(CODE), A.was), renamedUnsent(A.was));

    await signIn("1", A);
    await openEditor();

    await vi.waitFor(() => expect(arrived()).toMatchObject([{ as: "A", op: renameOp }]));
    await vi.waitFor(() => expect(slot(A.now)?.pending).toEqual([]));
    expect(slot(A.was)).toBeUndefined();
  });

  it("wait their turn, untouched, behind unsent edits the account's own copy holds", async () => {
    records.set(accountSlot(claimedLocalKey(CODE), A.now), {
      snapshot: { ...fresh(), ...NOTE },
      pending: [noteOp],
      updatedAt: 2,
      account: A.now,
    });
    records.set(accountSlot(claimedLocalKey(CODE), A.was), renamedUnsent(A.was));

    await signIn("1", A);
    await openEditor();
    await vi.waitFor(() => expect(arrived()).toMatchObject([{ as: "A", op: noteOp }]));
    await vi.waitFor(() => expect(slot(A.now)?.pending).toEqual([]));
    // neither sent out of turn nor thrown away
    expect(slot(A.was)?.pending).toMatchObject([renameOp]);

    // the next time the list is opened they are the only ones waiting
    await leave();
    await openEditor();
    await vi.waitFor(() => expect(arrived()).toMatchObject([{ op: noteOp }, { as: "A", op: renameOp }]));
    await vi.waitFor(() => expect(slot(A.now)?.pending).toEqual([]));
    expect(slot(A.was)).toBeUndefined();
    expect(serverList).toMatchObject({ ...RENAME, ...NOTE });
  });
});

describe("a list already open when the account's stored marker is first heard", () => {
  // The first launch on this shell: the last one left its sign-in, the marker it knew
  // the account by, and the list, which opens from the device before the session answers.
  it("carries on as the same account's, and is filed under the stored marker from its next open", async () => {
    cookiesFor("1", A);
    storage.set("gear.account.v1.1", A.was);
    records.set(accountSlot(claimedLocalKey(CODE), A.was), renamedUnsent(A.was));
    let answer!: () => void;
    meHeld = new Promise((r) => (answer = r));
    const asking = useSession().refresh(true);

    const c = await openEditor();
    expect(c.snapshot.value?.title).toBe(RENAME.title);
    await vi.waitFor(() => expect(arrived()).toMatchObject([{ as: "A", op: renameOp }]));
    const session = c.epochRef.value;
    const opened = opens;

    answer();
    await asking;
    expect(useSession().user.value).toMatchObject({ account: A.now, accountWas: A.was });
    c.setMeta(NOTE);
    await vi.waitFor(() => expect(arrived()).toMatchObject([{ op: renameOp }, { as: "A", op: noteOp }]));
    await settle();
    // the same open throughout: never closed, never loaded again
    expect(c.epochRef.value).toBe(session);
    expect(opens).toBe(opened);

    await leave();
    await openEditor();
    await vi.waitFor(() => expect(slot(A.now)).toMatchObject({ snapshot: { ...RENAME, ...NOTE }, pending: [] }));
    expect(slot(A.was)).toBeUndefined();
    expect(arrived()).toHaveLength(2); // nothing went a second time
  });

  it("carries on when a server from before answered first", async () => {
    server = "before";
    expect(await signIn("1", A)).toMatchObject({ account: A.was });
    const c = await openEditor();
    const session = c.epochRef.value;
    const opened = opens;

    server = "both";
    await useSession().refresh(true);
    expect(useSession().user.value).toMatchObject({ account: A.now, accountWas: A.was });
    c.setMeta(RENAME);
    await vi.waitFor(() => expect(arrived()).toMatchObject([{ as: "A", op: renameOp }]));
    await settle();
    expect(c.epochRef.value).toBe(session);
    expect(opens).toBe(opened);
  });

  it("stays that account's when a server from before answers after", async () => {
    await signIn("1", A);
    const c = await openEditor();
    const session = c.epochRef.value;

    server = "before";
    await useSession().refresh(true);
    await settle();
    expect(useSession().user.value?.account).toBe(A.now);
    expect(c.epochRef.value).toBe(session);
  });
});

describe("once the server answers only the stored marker", () => {
  it("reads it from `account`, whatever a shell from before remembered for the session", async () => {
    server = "after";
    storage.set("gear.account.v1.1", A.was);
    records.set(accountSlot(claimedLocalKey(CODE), A.now), { ...renamedUnsent(A.now), updatedAt: 2 });

    const user = await signIn("1", A);
    expect(user?.account).toBe(A.now);
    expect(user?.accountWas).toBeUndefined();
    await openEditor();
    await vi.waitFor(() => expect(arrived()).toMatchObject([{ as: "A", op: renameOp }]));
  });

  it("keeps a list open across the change", async () => {
    await signIn("1", A);
    const c = await openEditor();
    const session = c.epochRef.value;

    server = "after";
    await useSession().refresh(true);
    c.setMeta(RENAME);
    await vi.waitFor(() => expect(arrived()).toMatchObject([{ as: "A", op: renameOp }]));
    expect(useSession().user.value?.account).toBe(A.now);
    expect(c.epochRef.value).toBe(session);
  });
});
