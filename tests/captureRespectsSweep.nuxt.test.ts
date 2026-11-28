// Whose gear goes to My Gear without anyone asking. A sign-in link asked for on one
// browser and opened on another signs the second one in only once its person says the
// account is theirs, and the lists that browser holds are a second question (`sweep` on
// the session). The gear in those lists is the same question: opening someone's
// sign-in link on your own computer must not put your gear in their My Gear at your
// next edit.
//
// The real editor, controller, session and capture run here. The server is the only
// double, and it answers for whoever its session says is signed in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSuspended, registerEndpoint } from "@nuxt/test-utils/runtime";
import { flushPromises, type VueWrapper } from "@vue/test-utils";
import { createError, getHeader, readBody, type H3Event } from "h3";
import { folder, gear, snapshotFor } from "./helpers/list";
import { stubLocalStorage } from "./helpers/storage";
import { LIST_CODE_HEADER } from "~~/shared/links";
import { vaultNormKey } from "~~/shared/vault";
import type { ListSnapshot } from "~~/shared/types";
import { _setFlushDebounce } from "~/composables/useGearList";
import { _pendingCapture, _setCaptureDebounce } from "~/composables/useVault";
import GearEditor from "~/components/GearEditor.client.vue";

const storage = stubLocalStorage();

const CODE = "TESTC0DE0001";
const TOKEN = "an-edit-token-held-here";
const TENT = gear();
const TENT_KEY = vaultNormKey(TENT.brand, TENT.name, TENT.variant);
const fresh = (): ListSnapshot =>
  snapshotFor({ shareCode: CODE, slug: "alpine-loop-aaa111", title: "Alpine Loop", folders: [folder()], items: [TENT] });

// ---- the server: one list, one account that holds it, and its My Gear ----------------
/** `sweep`: whether this session's sign-in brought the browser's lists (startSession). */
let signedInAs: { owner: string; account: string; sweep: boolean } | null = null;
let serverList = fresh();
/** Held to keep the session check unanswered; the check answers when it resolves. */
let meGate: Promise<void> | null = null;
let answerMe = () => {};
/** Every write to My Gear: whose it reached, and whether a row's own Save sent it. */
let captured: { as: string | null; byHand: boolean }[] = [];
const unasked = () => captured.filter((c) => !c.byHand);
/** The edit link opens the list for anyone; the code opens it for the account. */
function allow(event: H3Event) {
  if (getHeader(event, "authorization") === `Bearer ${TOKEN}`) return;
  if (getHeader(event, LIST_CODE_HEADER) === CODE && signedInAs) return;
  throw createError({ statusCode: 401, statusMessage: "Missing edit capability" });
}
registerEndpoint("/api/auth/me", async () => {
  await meGate;
  return { user: signedInAs && { ...signedInAs, email: "a@example.com", displayName: null } };
});
registerEndpoint("/api/auth/signout", { method: "POST", handler: () => ((signedInAs = null), {}) });
registerEndpoint("/api/auth/sweep", { method: "POST", handler: () => ((signedInAs!.sweep = true), {}) });
registerEndpoint("/api/lists/claimed", () => ({ lists: [] }));
registerEndpoint("/api/edit/list", (event) => (allow(event), { snapshot: serverList }));
registerEndpoint("/api/edit/mutate", {
  method: "POST",
  handler: (event) => {
    allow(event);
    serverList = { ...serverList, version: serverList.version + 1 };
    return { snapshot: serverList };
  },
});
registerEndpoint("/api/edit/changes", (event) => (allow(event), { version: serverList.version }));
registerEndpoint("/api/catalog/use", () => ({}));
registerEndpoint("/api/vault/among", { method: "POST", handler: () => ({ keys: [] }) });
registerEndpoint("/api/vault/capture", {
  method: "POST",
  handler: async (event) => {
    const body = await readBody<{ overwriteWeight?: boolean }>(event);
    captured.push({ as: signedInAs?.account ?? null, byHand: body?.overwriteWeight === true });
    return { keys: [[TENT_KEY, TENT.unitWeightMg]] };
  },
});

// ---- the browser ---------------------------------------------------------------------
/** The cookies a sign-in leaves, and this tab's check of them, which is not waited for. */
function arrive(sweep: boolean): Promise<void> {
  signedInAs = { owner: "1", account: "aaaa", sweep };
  document.cookie = "mh_signed_in=1; path=/";
  document.cookie = "mh_session_owner=1; path=/";
  return useSession().refresh(true);
}
/** Signed in, and this tab knows it. `sweep: false` is a sign-in only confirmed here. */
async function signIn(sweep: boolean) {
  await arrive(sweep);
  expect(useSession().user.value?.sweep).toBe(sweep);
}
/** A page that has just loaded signed in, its check not answered yet; call what comes
 *  back to let it answer. */
function signInUnanswered(sweep: boolean): () => Promise<void> {
  useState("session").value = { state: "unresolved" };
  meGate = new Promise((r) => (answerMe = r));
  const asking = arrive(sweep);
  return () => (answerMe(), (meGate = null), asking);
}
/** This device made the list: "is this gear yours?" was answered yes as it was made. */
const madeHere = () => storage.set(`gear.vault.answer.${CODE}`, "yes");
const HELD = `/e/${CODE}#${TOKEN}`;
/** Any edit: each one offers the whole list's gear. */
const edit = (c: ReturnType<typeof useGearList>) => c.setMeta({ title: "Renamed" });
/** Long enough for anything that was going to be sent to have been. */
const settle = () => new Promise((r) => setTimeout(r, 250));

let wrapper: VueWrapper | undefined;
async function openEditor(route: string) {
  wrapper = await mountSuspended(GearEditor, { route });
  const c = useGearList();
  await vi.waitFor(() => expect(c.status.value).toBe("synced"));
  return c;
}

const beacon = vi.fn(() => true);
beforeEach(() => {
  _setFlushDebounce(20);
  _setCaptureDebounce(20);
  vi.stubGlobal("indexedDB", undefined); // nothing here is about the copy on the device
  Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
  beacon.mockClear();
  storage.clear();
  serverList = fresh();
  signedInAs = null;
  meGate = null;
  window.dispatchEvent(new Event("online"));
});
afterEach(async () => {
  answerMe(); // a case that failed with the check still held
  wrapper?.unmount();
  wrapper = undefined;
  useGearList().dispose();
  signedInAs = null;
  await useSession().signOut();
  await flushPromises();
  await settle();
  captured = [];
  _setFlushDebounce();
  _setCaptureDebounce();
});

describe("the gear of a list this device holds, under a sign-in only confirmed here", () => {
  it("sends none of a list made here to the account's My Gear", async () => {
    madeHere();
    await signIn(false);
    const c = await openEditor(HELD);
    edit(c);
    await settle();
    expect(captured).toEqual([]);
  });

  it("sends none of a draft's", async () => {
    await signIn(false);
    const c = useGearList();
    window.dispatchEvent(new Event("offline")); // so the draft stays one
    c.startDraft();
    const id = c.addBlankItem(null);
    c.updateItem(id, { name: "Duplex", brand: "Zpacks", unitWeightMg: 539_000 });
    await settle();
    expect(captured).toEqual([]);
  });

  it("does not ask whether a held link's gear is theirs either", async () => {
    await signIn(false);
    const c = await openEditor(HELD); // an edit link with no answer on this device
    edit(c);
    await settle();
    expect(c.vaultPrompt.value).toBeNull();
    expect(captured).toEqual([]);
  });

  it("leaves each row its own Save, and takes a press of it", async () => {
    madeHere();
    await signIn(false);
    const c = await openEditor(HELD);
    // the row is not called covered by a capture that is not going to happen
    expect(c.vaultAuto.value).toBe(false);

    expect(await c.saveItemToVault(TENT.id)).toBe("saved");
    expect(captured).toEqual([{ as: "aaaa", byHand: true }]);
  });

  it("sends it once the person says this browser's lists may come", async () => {
    madeHere();
    await signIn(false);
    const c = await openEditor(HELD);
    edit(c);
    await settle();

    expect(await useSession().allowListSweep()).toBe(true);
    await vi.waitFor(() => expect(captured).toEqual([{ as: "aaaa", byHand: false }]));
    expect(c.vaultAuto.value).toBe(true);
  });

  it("sends none of what was edited before the session had answered", async () => {
    madeHere();
    const answer = signInUnanswered(false);
    const c = await openEditor(HELD);
    edit(c);
    await vi.waitFor(() => expect(_pendingCapture()).toBe(true));
    await settle(); // well past the capture's own wait
    await answer();
    await settle();
    expect(captured).toEqual([]);
    expect(_pendingCapture()).toBe(false);
  });

  it("hands none to the browser as the page is left with the session unanswered", async () => {
    madeHere();
    _setCaptureDebounce(5_000);
    const answer = signInUnanswered(false);
    const c = await openEditor(HELD);
    edit(c);
    await vi.waitFor(() => expect(_pendingCapture()).toBe(true));
    window.dispatchEvent(new Event("pagehide"));
    expect(beacon).not.toHaveBeenCalled();
    await answer();
  });
});

describe("gear that still goes without asking", () => {
  it("a list made here, under a sign-in made here", async () => {
    madeHere();
    await signIn(true);
    const c = await openEditor(HELD);
    expect(c.vaultAuto.value).toBe(true);
    edit(c);
    await vi.waitFor(() => expect(captured).toEqual([{ as: "aaaa", byHand: false }]));
  });

  it("a list opened through the account, however the session got here", async () => {
    await signIn(false);
    const c = await openEditor(`/e/${CODE}`);
    expect(c.vaultAuto.value).toBe(true);
    edit(c);
    await vi.waitFor(() => expect(unasked()).toEqual([{ as: "aaaa", byHand: false }]));
  });

  it("an edit made before the session answered, once it says the lists came with it", async () => {
    madeHere();
    const answer = signInUnanswered(true);
    const c = await openEditor(HELD);
    edit(c);
    await vi.waitFor(() => expect(_pendingCapture()).toBe(true));
    await settle(); // the capture's own wait is over, and it is waiting for the answer
    expect(captured).toEqual([]);
    await answer();
    await vi.waitFor(() => expect(captured).toEqual([{ as: "aaaa", byHand: false }]));
  });

  it("is handed to the browser as the page is left, for a session that brought the lists", async () => {
    madeHere();
    _setCaptureDebounce(5_000);
    await signIn(true);
    const c = await openEditor(HELD);
    edit(c);
    await vi.waitFor(() => expect(_pendingCapture()).toBe(true));
    window.dispatchEvent(new Event("pagehide"));
    expect(beacon).toHaveBeenCalledTimes(1);
  });
});
