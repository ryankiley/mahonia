// @vitest-environment nuxt
//
// The ONE suite here that needs a Nuxt app booted. Everything else in tests/ is
// plain TS on the node environment and should stay that way — see vitest.config.ts.
//
// Why this can't be plain TS: the bug under test isn't a decision a pure function
// makes, it's an ORDERING hazard between three side effects that only exist inside
// the live controller — flush() splicing ops out of the queue, dispose() rewriting
// the on-device record, and the in-flight request's catch running after both. A
// helper extracted for testability would be exercising a different shape than the
// one that breaks. So: boot Nuxt, stub the two boundaries (the fetch and the
// IndexedDB store), and drive the real singleton through the real sequence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { createError } from "h3";
import { localKey, type LocalListRecord } from "~~/shared/localList";
import type { Folder, Item, ListSnapshot } from "~~/shared/types";
import { resetVaultCapture, useVaultCapture, vaultDecisionFor } from "~/composables/useVault";

// ---- the on-device store, in memory ------------------------------------------
// Stands in for useLocalListStore's IndexedDB. Deep-copies on write exactly as the
// real one does (it JSON round-trips to strip Vue's reactive proxy), so a test can
// never accidentally assert against a live reference to the controller's own state.
const records = new Map<string, LocalListRecord>();
mockNuxtImport("useLocalListStore", () => () => ({
  get: async (key: string) => records.get(key),
  set: async (key: string, record: LocalListRecord) => {
    records.set(key, JSON.parse(JSON.stringify(record)));
  },
  del: async (key: string) => {
    records.delete(key);
  },
}));

// ---- localStorage -------------------------------------------------------------
// Node's own `localStorage` global is inert without --localstorage-file (every
// method throws), and the vault's per-list decision lives there. A Map-backed stub
// is what the browser actually gives us, and it makes the store clearable between
// tests — which Node's, notably, is not.
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
});

// ---- the network --------------------------------------------------------------
const TOKEN = "test-edit-token";
const snapshotFor = (title: string, version = 1): ListSnapshot => ({
  shareCode: "SNAPCODE0001",
  slug: "test-list-aaa111",
  title,
  description: "",
  displayUnit: "g",
  folders: [],
  items: [],
  version,
  isPublic: false,
});

// Routes go through registerEndpoint, NOT a $fetch global stub: under the Nuxt
// environment $fetch is already bound to test-utils' own mock, which 404s anything
// unregistered — a plain vi.stubGlobal never gets a look in (the controller just
// reports the list "missing" and no flush is ever attempted).
// What /api/edit/list hands back. A `let` because the vault-prompt suite below
// needs lists with actual gear in them (an empty one has nothing to capture, so it
// could never raise the question).
let listResponse: ListSnapshot = snapshotFor("Original");
registerEndpoint("/api/edit/list", () => ({ snapshot: listResponse }));
registerEndpoint("/api/edit/changes", () => ({ version: 1 })); // the live-sync poll
registerEndpoint("/api/catalog/use", () => ({})); // fire-and-forget ranking ping

let captureCalls = 0;
registerEndpoint("/api/vault/capture", { method: "POST", handler: () => {
  captureCalls++;
  return { vaultToken: "test-vault-token" };
} });

// The mutate is left hanging until the test settles it by hand — that pending window
// IS the bug's window, and controlling it is the whole point.
let mutateCalls = 0;
let settleMutate: { resolve: (v: unknown) => void; reject: (e: unknown) => void };
registerEndpoint("/api/edit/mutate", {
  method: "POST",
  handler: () => {
    mutateCalls++;
    return new Promise((resolve, reject) => {
      settleMutate = { resolve, reject };
    });
  },
});

// flush() is debounced 450ms behind a dispatch and isn't exported, so the test
// waits for the request to actually leave rather than reaching inside.
const awaitMutateInFlight = () =>
  vi.waitFor(() => expect(mutateCalls).toBe(1), { timeout: 5_000, interval: 25 });

describe("useGearList — a flush that fails after the editor moved on", () => {
  beforeEach(() => {
    records.clear();
    mutateCalls = 0;
    listResponse = snapshotFor("Original");
  });
  afterEach(() => {
    // the controller is a module singleton: hand it back clean, and stop its poll
    useGearList().dispose();
  });

  // The regression this suite exists for. Sequence:
  //   1. an edit is queued and flush() splices it out of `pending` into a request
  //   2. the user navigates out of the editor mid-flight → dispose() runs, writing
  //      the now-EMPTY queue over this list's on-device record, and bumps the epoch
  //   3. the request fails (the connection that dropped is often why they left)
  //   4. the catch sees a moved epoch — and must not simply return
  // Before the fix step 4 returned, and the ops existed nowhere: not on the server,
  // not in `pending`, not on disk.
  it("recovers the in-flight ops into that list's on-device record", async () => {
    const c = useGearList();
    await c.load(TOKEN);
    c.setMeta({ title: "Renamed while leaving" });

    await awaitMutateInFlight();

    // the SPA navigation lands mid-flight
    c.dispose();
    // dispose() writes synchronously; prove the queue really was clobbered, so this
    // test fails loudly if that ordering ever changes and the premise goes stale
    await vi.waitFor(() => expect(records.get(localKey(TOKEN))?.pending).toEqual([]));

    // ...and only THEN does the request fail
    settleMutate.reject(createError({ statusCode: 500, statusMessage: "network" }));

    await vi.waitFor(() => {
      const rec = records.get(localKey(TOKEN));
      expect(rec?.pending).toHaveLength(1);
      expect(rec?.pending[0]).toMatchObject({ t: "setMeta" });
    });
    // the snapshot stored alongside them is the one the ops were computed against,
    // so the next open replays them onto a consistent base
    expect(records.get(localKey(TOKEN))?.snapshot.title).toBe("Renamed while leaving");
  });

  // The recovery must be SPECIFIC to the moved-epoch case. A flush that succeeds has
  // landed its ops server-side, so writing them back would resurrect them on the next
  // open and re-apply edits the server already has.
  it("writes nothing back when the in-flight batch actually succeeded", async () => {
    const c = useGearList();
    await c.load(TOKEN);
    c.setMeta({ title: "Renamed while leaving" });

    await awaitMutateInFlight();
    c.dispose();
    settleMutate.resolve({ snapshot: snapshotFor("Renamed while leaving", 2) });

    // give the settled promise's continuation a chance to run before asserting a
    // negative — otherwise this passes for the wrong reason
    await new Promise((r) => setTimeout(r, 50));
    expect(records.get(localKey(TOKEN))?.pending).toEqual([]);
  });

  // And the ordinary failure path — still on the same list — must keep behaving as it
  // did: re-queued in memory for the retry, and persisted, not diverted to the
  // recovery write.
  it("re-queues normally when the failure happens on the list still open", async () => {
    const c = useGearList();
    await c.load(TOKEN);
    c.setMeta({ title: "Renamed in place" });

    await awaitMutateInFlight();
    settleMutate.reject(createError({ statusCode: 500, statusMessage: "boom" }));

    await vi.waitFor(() => {
      const rec = records.get(localKey(TOKEN));
      expect(rec?.pending).toHaveLength(1);
      expect(rec?.pending[0]).toMatchObject({ t: "setMeta" });
    });
    // The op went back into the in-memory queue, not down the recovery path: flush()
    // only fires when `pending` is non-empty, so a second attempt is the proof.
    // (Deliberately NOT asserting status === "error" here — the failure sets it, then
    // the retry sets "saving" 450ms later, so that assertion races the very retry
    // this behaviour is for.)
    await vi.waitFor(() => expect(mutateCalls).toBe(2), { timeout: 5_000, interval: 25 });
  });
});

// ---------------------------------------------------------------------------
// "Add this list's gear to your gear vault?"
// ---------------------------------------------------------------------------
// Same reason as the suite above: the behaviour under test is not a decision a
// pure function makes, it's WHEN the live controller raises the question — which
// depends on load()'s backfills, on dispatch()'s funnel, and on a capture set that
// isn't built until a dynamic import resolves. Only the real controller has that
// shape.
//
// The rule being locked in: an edit link is either your own list on a second
// device or one a friend sent you. So the editor asks ONCE per list, remembers the
// answer, and until it has one, nothing reaches the vault.
const gear = (over: Partial<Item> = {}): Item => ({
  id: "i1",
  folderId: "f1",
  name: "Duplex",
  brand: "Zpacks",
  unitWeightMg: 539_000,
  qty: 1,
  classification: null,
  sortOrder: 0,
  ...over,
});
const folder = (over: Partial<Folder> = {}): Folder => ({
  id: "f1",
  name: "Shelter",
  defaultClassification: null,
  sortOrder: 0,
  colorKey: "green",
  ...over,
});
const withGear = (items: Item[], folders: Folder[] = [folder()]): ListSnapshot => ({
  ...snapshotFor("A friend's list"),
  folders,
  items,
});

describe("useGearList — whose gear is this?", () => {
  beforeEach(() => {
    records.clear();
    mutateCalls = 0;
    captureCalls = 0;
    storage.clear(); // the decision store
    resetVaultCapture(); // the capture memo is module-scoped
    listResponse = withGear([gear()]);
  });
  afterEach(() => {
    useGearList().dispose();
  });

  it("asks before a single row of someone else's gear reaches the vault", async () => {
    const c = useGearList();
    await c.load(TOKEN);
    c.updateItem("i1", { qty: 2 });

    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());
    expect(vaultDecisionFor(TOKEN)).toBe("ask");
    // and it is still only a question — nothing has been sent (the capture debounce
    // is 4s, so this window is well inside it either way, but the guard returns
    // before anything is even queued)
    expect(captureCalls).toBe(0);
  });

  // The regression that made the ask worth nothing. load() runs three one-time
  // backfills (water rename, folder colours, stranded children) through the SAME
  // dispatch() every user edit goes through — so merely OPENING a shared list
  // captured the whole thing before its owner's gear was ever in question.
  it("does not capture — or ask — for load()'s own backfills", async () => {
    listResponse = withGear(
      [gear(), gear({ id: "i2", name: "Water · 1 L", brand: undefined, classification: "consumable" })],
      [folder({ colorKey: "other" })], // triggers the colour backfill
    );
    const c = useGearList();
    await c.load(TOKEN);

    // the backfills really did run (else this passes for the wrong reason)
    await vi.waitFor(() => {
      expect(c.snapshot.value?.items.find((i) => i.id === "i2")?.name).toBe("Water");
      expect(c.snapshot.value?.folders[0]?.colorKey).not.toBe("other");
    });
    expect(c.vaultPrompt.value).toBeNull();
    expect(captureCalls).toBe(0);
  });

  // A question whose answer changes nothing, asked once and never again, is worse
  // than no question: it burns the one chance to ask about this list.
  it("never asks about a list with no gear in it", async () => {
    listResponse = withGear([gear({ unitWeightMg: 0, brand: undefined, name: "Notes to self" })]);
    const c = useGearList();
    await c.load(TOKEN);
    c.updateItem("i1", { qty: 2 });

    await new Promise((r) => setTimeout(r, 50)); // let the dynamic import settle
    expect(c.vaultPrompt.value).toBeNull();
    expect(vaultDecisionFor(TOKEN)).toBe("ask");
  });

  it("takes yes for an answer, captures, and stops asking", async () => {
    const c = useGearList();
    await c.load(TOKEN);
    c.updateItem("i1", { qty: 2 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());

    c.answerVaultPrompt(true);
    expect(c.vaultPrompt.value).toBeNull();
    expect(vaultDecisionFor(TOKEN)).toBe("yes");

    // the capture is debounced 4s behind the answer
    await vi.waitFor(() => expect(captureCalls).toBe(1), { timeout: 8_000, interval: 50 });

    c.updateItem("i1", { qty: 3 });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.vaultPrompt.value).toBeNull();
  });

  // Dismissing IS answering — the whole point of the banner over a toast. "No" has
  // to outlive the tab, or every reload re-asks about a friend's list until one
  // stray tap lands on Add.
  it("takes dismissal for a no, and holds it across a reload", async () => {
    const c = useGearList();
    await c.load(TOKEN);
    c.updateItem("i1", { qty: 2 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());

    c.answerVaultPrompt(false);
    expect(c.vaultPrompt.value).toBeNull();
    expect(vaultDecisionFor(TOKEN)).toBe("no");

    c.updateItem("i1", { qty: 3 });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.vaultPrompt.value).toBeNull();

    // reload: a fresh controller on the same list, reading the same store
    c.dispose();
    const reopened = useGearList();
    await reopened.load(TOKEN);
    reopened.updateItem("i1", { qty: 4 });
    await new Promise((r) => setTimeout(r, 50));
    expect(reopened.vaultPrompt.value).toBeNull();
    expect(captureCalls).toBe(0);
  });

  // The question is about the list in front of you. Left standing after a
  // navigation it asks about the wrong gear — and, answered, spends the NEW list's
  // one chance to ask on a question that was never posed about it.
  it("does not carry an unanswered question onto the next list opened", async () => {
    const c = useGearList();
    await c.load(TOKEN);
    c.updateItem("i1", { qty: 2 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());

    // ...and off they go to their own list without answering
    c.dispose();
    listResponse = withGear([gear({ unitWeightMg: 0, brand: undefined, name: "Notes" })]);
    const mine = useGearList();
    await mine.load("another-edit-token");
    expect(mine.vaultPrompt.value).toBeNull();

    // a brand-new draft is likewise never greeted with someone else's question
    mine.dispose();
    const draft = useGearList();
    draft.startDraft();
    expect(draft.vaultPrompt.value).toBeNull();
  });

  // A list that arrived WHOLE — imported from LighterPack, cloned from a public
  // list — captures at the moment it's created, because nothing else would ever
  // offer it. Recording the answer there is what stops the very next keystroke
  // asking whether the gear you just imported is really yours.
  it("never asks about a list this device just imported or cloned", async () => {
    useVaultCapture().captureNewList(withGear([gear()]), TOKEN);
    expect(vaultDecisionFor(TOKEN)).toBe("yes");

    const c = useGearList();
    await c.load(TOKEN);
    c.updateItem("i1", { qty: 2 });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.vaultPrompt.value).toBeNull();
  });
});
