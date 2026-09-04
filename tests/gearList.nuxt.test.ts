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
import { createError, readBody } from "h3";
import { localKey, type LocalListRecord } from "~~/shared/localList";
import type { Folder, Item, ListSnapshot } from "~~/shared/types";
import type { VaultEntry } from "~~/shared/vault";
import { vaultNormKey } from "~~/shared/vault";
import { noteVaultKeys, vaultKeysEpoch } from "~/composables/useVaultKeys";
import {
  resetVaultCapture,
  setVaultDecisionFor,
  useVaultCapture,
  vaultDecisionFor,
  vaultExclusionsFor,
} from "~/composables/useVault";

// ---- the on-device store, in memory ------------------------------------------
// Stands in for useLocalListStore's IndexedDB. Deep-copies on write exactly as the
// real one does (it JSON round-trips to strip Vue's reactive proxy), so a test can
// never accidentally assert against a live reference to the controller's own state.
const records = new Map<string, LocalListRecord>();
// The vault only ASKS someone who has one — the prompt is an offer to put gear
// somewhere, and signed out there is nowhere. These cases are about the question
// itself, so they're run as a holder of a vault; the signed-out path has its own
// case at the end of the file.
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  // the session has ANSWERED — the vault's reads (useVaultKeys) wait on this, so
  // a mock that only carried hasVault left them hanging
  vaultKnown: ref(true),
  vaultFetch: <T,>(url: string, opts?: Parameters<typeof $fetch>[1]) =>
    $fetch(url, { ...opts, credentials: "same-origin" }) as Promise<T>,
}));

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
// navigator.sendBeacon — the ONLY way a pending capture gets out as the page goes
// away (an in-flight fetch is routinely killed on unload). Spied rather than
// stubbed away, because what the beacon CARRIES is the thing worth asserting.
const beacons: { url: string; body: unknown }[] = [];
let beaconWorks = true;
Object.defineProperty(navigator, "sendBeacon", {
  configurable: true,
  writable: true,
  value: (url: string, blob: Blob) => {
    // Blob.text() is async and flush() is deliberately synchronous, so read the
    // payload the same way the endpoint would rather than awaiting here
    beacons.push({ url, body: JSON.parse((blob as unknown as { _text?: string })._text ?? "null") });
    return beaconWorks;
  },
});
// happy-dom's Blob doesn't expose its parts synchronously; capture them on construction
const RealBlob = globalThis.Blob;
class TextCapturingBlob extends RealBlob {
  _text: string;
  constructor(parts: BlobPart[], options?: BlobPropertyBag) {
    super(parts, options);
    this._text = parts.map(String).join("");
  }
}
globalThis.Blob = TextCapturingBlob as unknown as typeof Blob;

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
// what My Gear already holds, as [normKey, weightMg] tuples — read when a list
// opens whose own answer doesn't already cover it (useVaultKeys). Empty here:
// these cases are about capture, and an empty vault is what makes every row a
// genuine capture.
registerEndpoint("/api/vault/keys", () => ({ keys: [] }));

let captureCalls = 0;
// what each capture actually carried — the picker tests assert on the ROWS, not
// just that a write happened
let captureBodies: { name: string }[][] = [];
registerEndpoint("/api/vault/capture", { method: "POST", handler: async (event) => {
  captureCalls++;
  const body = await readBody<{ items?: { name: string }[] }>(event);
  captureBodies.push(body?.items ?? []);
  return { vaultToken: "test-vault-token" };
} });

// The link a rotate mints. A constant, because the one thing the rotate tests
// need from the endpoint is that the token CHANGES.
const ROTATED_TOKEN = "rotated-edit-token";
registerEndpoint("/api/edit/rotate", { method: "POST", handler: () => ({ editToken: ROTATED_TOKEN }) });

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
    await c.load({ token: TOKEN });
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
    await c.load({ token: TOKEN });
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
    await c.load({ token: TOKEN });
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
// "Add this list's gear to My Gear?"
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
  // no default class: Classification has no null member, but weights.ts reads this
  // as `?? "base"` — this is the shape that guard is for, so the fixture keeps it.
  defaultClassification: null as never,
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
    captureBodies = [];
    storage.clear(); // the decision store
    resetVaultCapture(); // the capture memo is module-scoped
    listResponse = withGear([gear()]);
  });
  afterEach(() => {
    useGearList().dispose();
  });

  it("asks before a single row of someone else's gear reaches the vault", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    c.updateItem("i1", { qty: 2 });

    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());
    expect(vaultDecisionFor(TOKEN)).toBe("ask");
    // and it is still only a question — nothing has been sent (the capture debounce
    // is 4s, so this window is well inside it either way, but the guard returns
    // before anything is even queued)
    expect(captureCalls).toBe(0);
    // the rows' mirror of the answer agrees: unanswered is not covered, so every
    // row's save button stays a live action
    expect(c.vaultAuto.value).toBe(false);
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
    await c.load({ token: TOKEN });

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
    await c.load({ token: TOKEN });
    c.updateItem("i1", { qty: 2 });

    await new Promise((r) => setTimeout(r, 50)); // let the dynamic import settle
    expect(c.vaultPrompt.value).toBeNull();
    expect(vaultDecisionFor(TOKEN)).toBe("ask");
  });

  it("takes yes for an answer, captures, and stops asking", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    c.updateItem("i1", { qty: 2 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());

    // one row, so no chooser — but answering is async now (it has to build the
    // capture set before it knows whether there's anything to choose between)
    await c.answerVaultPrompt(true);
    expect(c.vaultPrompt.value).toBeNull();
    expect(vaultDecisionFor(TOKEN)).toBe("yes");
    // ...and the rows learn it the same moment: the automatic path now has this
    // list, so the save buttons flip to "already banked" without a reload
    expect(c.vaultAuto.value).toBe(true);

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
    await c.load({ token: TOKEN });
    c.updateItem("i1", { qty: 2 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());

    c.answerVaultPrompt(false);
    expect(c.vaultPrompt.value).toBeNull();
    expect(vaultDecisionFor(TOKEN)).toBe("no");
    expect(c.vaultAuto.value).toBe(false); // no cover claimed for a declined list

    c.updateItem("i1", { qty: 3 });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.vaultPrompt.value).toBeNull();

    // reload: a fresh controller on the same list, reading the same store
    c.dispose();
    const reopened = useGearList();
    await reopened.load({ token: TOKEN });
    reopened.updateItem("i1", { qty: 4 });
    await new Promise((r) => setTimeout(r, 50));
    expect(reopened.vaultPrompt.value).toBeNull();
    expect(captureCalls).toBe(0);
  });

  // The same proxy that made the save button lie also raises this question, and
  // the vault can now answer it: a list whose every row is already banked has
  // nothing to consent to and nothing to move.
  it("does not ask about a list whose gear My Gear already holds", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    // what /api/vault/keys would have said: this list's one row, already banked
    const item = listResponse.items[0]!;
    noteVaultKeys([[vaultNormKey(item.brand, item.name, item.variant), item.unitWeightMg]], vaultKeysEpoch());
    c.updateItem("i1", { qty: 2 });
    await new Promise((r) => setTimeout(r, 50));
    // no modal over a list to request permission for a no-op — and, crucially,
    // the list's one chance to ask is NOT spent: the question stays open for gear
    // added later that the vault genuinely doesn't have
    expect(c.vaultPrompt.value).toBeNull();
    expect(vaultDecisionFor(TOKEN)).toBe("ask");
    expect(captureCalls).toBe(0);
  });

  it("still asks as soon as one row is gear the vault doesn't hold", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    noteVaultKeys([["something else entirely", 1_000]], vaultKeysEpoch());
    c.updateItem("i1", { qty: 2 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());
  });

  // The question is about the list in front of you. Left standing after a
  // navigation it asks about the wrong gear — and, answered, spends the NEW list's
  // one chance to ask on a question that was never posed about it.
  it("does not carry an unanswered question onto the next list opened", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    c.updateItem("i1", { qty: 2 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());

    // ...and off they go to their own list without answering
    c.dispose();
    listResponse = withGear([gear({ unitWeightMg: 0, brand: undefined, name: "Notes" })]);
    const mine = useGearList();
    await mine.load({ token: "another-edit-token" });
    expect(mine.vaultPrompt.value).toBeNull();

    // a brand-new draft is likewise never greeted with someone else's question
    mine.dispose();
    const draft = useGearList();
    draft.startDraft();
    expect(draft.vaultPrompt.value).toBeNull();
  });

  // Answering "Add" on a shared list opens the chooser rather than taking the lot:
  // on a trip planned together the tent is yours and the stove isn't, and
  // all-or-nothing forces a wrong answer whichever way you go.
  it("offers a chooser instead of taking the whole list", async () => {
    listResponse = withGear([gear(), gear({ id: "i2", name: "Kakwa 55", brand: "Durston" })]);
    const c = useGearList();
    await c.load({ token: TOKEN });
    c.updateItem("i1", { qty: 2 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());

    await c.answerVaultPrompt(true);
    await vi.waitFor(() => expect(c.vaultPicker.value).not.toBeNull());
    expect(c.vaultPicker.value!.map((r) => r.name).sort()).toEqual(["Duplex", "Kakwa 55"]);
    // still nothing decided and nothing sent — opening the chooser is not answering
    expect(vaultDecisionFor(TOKEN)).toBe("ask");
    expect(captureCalls).toBe(0);
  });

  it("captures only what was ticked, and never re-offers the rest", async () => {
    listResponse = withGear([gear(), gear({ id: "i2", name: "Kakwa 55", brand: "Durston" })]);
    const c = useGearList();
    await c.load({ token: TOKEN });
    c.updateItem("i1", { qty: 2 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());
    await c.answerVaultPrompt(true);
    await vi.waitFor(() => expect(c.vaultPicker.value).not.toBeNull());

    const mine = c.vaultPicker.value!.find((r) => r.name === "Duplex")!;
    c.confirmVaultPicker([mine.normKey]);
    expect(vaultDecisionFor(TOKEN)).toBe("yes");
    // the rows' mirror carries BOTH halves of the choice: the list is covered,
    // except for the row that was left unticked — its save button stays live,
    // because pressing it is the one way that row ever gets banked
    expect(c.vaultAuto.value).toBe(true);
    expect(c.vaultDeclined.value.has(vaultNormKey("Durston", "Kakwa 55", undefined))).toBe(true);
    expect(c.vaultDeclined.value.has(mine.normKey)).toBe(false);

    await vi.waitFor(() => expect(captureCalls).toBe(1), { timeout: 8_000, interval: 50 });
    expect(captureBodies.at(-1)!.map((r) => r.name)).toEqual(["Duplex"]);

    // and the declined row stays declined. Capture re-reads the WHOLE list on every
    // edit, so without the exclusion the Kakwa would arrive on the next keystroke —
    // and note the assertion is that it never goes at all, not that a second write
    // happens: the capture set is unchanged, so the fingerprint gate correctly
    // suppresses the write entirely.
    c.updateItem("i2", { qty: 3 });
    await new Promise((r) => setTimeout(r, 5_000)); // past the 4s capture debounce
    expect(captureBodies.flat().map((r) => r.name)).toEqual(["Duplex"]);
  });

  // Gear you add to a shared list AFTER choosing is the gear most likely to be
  // yours — an allow-list would have silently excluded it forever.
  it("still captures gear added after the choice", async () => {
    listResponse = withGear([gear(), gear({ id: "i2", name: "Kakwa 55", brand: "Durston" })]);
    const c = useGearList();
    await c.load({ token: TOKEN });
    c.updateItem("i1", { qty: 2 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());
    await c.answerVaultPrompt(true);
    await vi.waitFor(() => expect(c.vaultPicker.value).not.toBeNull());
    c.confirmVaultPicker([c.vaultPicker.value!.find((r) => r.name === "Duplex")!.normKey]);
    await vi.waitFor(() => expect(captureCalls).toBe(1), { timeout: 8_000, interval: 50 });

    c.updateItem("i2", { name: "Nitecore NB10000" });
    await vi.waitFor(() => {
      expect(captureBodies.at(-1)!.map((r) => r.name).sort()).toEqual([
        "Duplex",
        "Nitecore NB10000",
      ]);
    }, { timeout: 8_000, interval: 50 });
  });

  // Backing out is not an answer. The question has to come back, or a stray click
  // on Add silently ends the conversation for that list.
  it("records nothing when the chooser is cancelled", async () => {
    listResponse = withGear([gear(), gear({ id: "i2", name: "Kakwa 55", brand: "Durston" })]);
    const c = useGearList();
    await c.load({ token: TOKEN });
    c.updateItem("i1", { qty: 2 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());
    await c.answerVaultPrompt(true);
    await vi.waitFor(() => expect(c.vaultPicker.value).not.toBeNull());

    c.cancelVaultPicker();
    expect(c.vaultPicker.value).toBeNull();
    expect(vaultDecisionFor(TOKEN)).toBe("ask");

    c.updateItem("i1", { qty: 3 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());
    expect(captureCalls).toBe(0);
  });

  // One row is not a choice. A dialog to tick the single thing you just said yes to
  // is a click that can only be answered one way.
  it("skips the chooser when there is only one piece of gear", async () => {
    listResponse = withGear([gear()]);
    const c = useGearList();
    await c.load({ token: TOKEN });
    c.updateItem("i1", { qty: 2 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());

    await c.answerVaultPrompt(true);
    expect(c.vaultPicker.value).toBeNull();
    expect(vaultDecisionFor(TOKEN)).toBe("yes");
    await vi.waitFor(() => expect(captureCalls).toBe(1), { timeout: 8_000, interval: 50 });
  });

  // A list that arrived WHOLE — imported from LighterPack, cloned from a public
  // list — captures at the moment it's created, because nothing else would ever
  // offer it. Recording the answer there is what stops the very next keystroke
  // asking whether the gear you just imported is really yours.
  it("never asks about a list this device just imported or cloned", async () => {
    useVaultCapture().captureNewList(withGear([gear()]), TOKEN);
    expect(vaultDecisionFor(TOKEN)).toBe("yes");

    const c = useGearList();
    await c.load({ token: TOKEN });
    c.updateItem("i1", { qty: 2 });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.vaultPrompt.value).toBeNull();
  });

  // The answer is keyed by the edit token, but it's ABOUT the gear — and a rotate
  // is the owner cycling a leaked link on a list they've already answered for. It
  // used to stay keyed to the dead token: the prompt re-asked, capture paused
  // until it was re-answered, and the orphaned keys sat in localStorage for good.
  it("carries the vault answer — exclusions included — across a rotate", async () => {
    listResponse = withGear([gear(), gear({ id: "i2", name: "Kakwa 55", brand: "Durston" })]);
    const c = useGearList();
    await c.load({ token: TOKEN });
    c.updateItem("i1", { qty: 2 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());
    await c.answerVaultPrompt(true);
    await vi.waitFor(() => expect(c.vaultPicker.value).not.toBeNull());
    const mine = c.vaultPicker.value!.find((r) => r.name === "Duplex")!;
    c.confirmVaultPicker([mine.normKey]);

    expect(await c.rotate()).toBe(ROTATED_TOKEN);
    // both halves of the answer moved onto the new token...
    expect(vaultDecisionFor(ROTATED_TOKEN)).toBe("yes");
    expect(vaultExclusionsFor(ROTATED_TOKEN).has(vaultNormKey("Durston", "Kakwa 55", undefined))).toBe(true);
    // ...the rows' mirror still says covered-except-the-declined-row...
    expect(c.vaultAuto.value).toBe(true);
    expect(c.vaultDeclined.value.has(vaultNormKey("Durston", "Kakwa 55", undefined))).toBe(true);
    // ...and the dead token's keys died with it (cleared reads as never-asked)
    expect(vaultDecisionFor(TOKEN)).toBe("ask");
    expect(vaultExclusionsFor(TOKEN).size).toBe(0);

    // the question, being answered, does not come back on the next edit
    c.updateItem("i1", { qty: 3 });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.vaultPrompt.value).toBeNull();
  });

  // A rotate on a never-answered list carries nothing and invents nothing: the
  // question stays open, and the prompt still comes.
  it("keeps an unanswered question open across a rotate", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    c.updateItem("i1", { qty: 2 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());

    // navigating away and rotating from a fresh session ("ask" never recorded)
    expect(await c.rotate()).toBe(ROTATED_TOKEN);
    expect(vaultDecisionFor(ROTATED_TOKEN)).toBe("ask");
    expect(c.vaultAuto.value).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the last-chance flush
// ---------------------------------------------------------------------------
// Capture is debounced 4s so typing a name is one write instead of one per
// keystroke — which means the common case (edit a list, close the tab) lands
// INSIDE the debounce with the rows still queued. pagehide is the only hook that
// reliably fires when mobile Safari backgrounds a tab, and a beacon is the only
// send that survives the document going away.
describe("useGearList — getting a pending capture out as the page goes away", () => {
  beforeEach(() => {
    records.clear();
    mutateCalls = 0;
    captureCalls = 0;
    captureBodies = [];
    beacons.length = 0;
    beaconWorks = true;
    storage.clear();
    resetVaultCapture();
    listResponse = withGear([gear()]);
  });
  afterEach(() => {
    useGearList().dispose();
  });

  it("beacons the queued rows on pagehide, well inside the debounce", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    setVaultDecisionFor(TOKEN, "yes"); // a list already known to be mine
    c.updateItem("i1", { qty: 2 });
    // let sync()'s dynamic import resolve and queue the rows, but nowhere near 4s
    await new Promise((r) => setTimeout(r, 200));

    window.dispatchEvent(new Event("pagehide"));

    expect(beacons).toHaveLength(1);
    expect(beacons[0]!.url).toBe("/api/vault/capture");
    expect((beacons[0]!.body as { items: { name: string }[] }).items.map((i) => i.name)).toEqual([
      "Duplex",
    ]);
  });

  // Belt and braces: having beaconed the rows, the debounce must not then send
  // them a second time if the page turns out to still be alive (a backgrounded
  // tab that comes back).
  it("does not also POST what it already beaconed", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    setVaultDecisionFor(TOKEN, "yes");
    c.updateItem("i1", { qty: 2 });
    await new Promise((r) => setTimeout(r, 200));
    window.dispatchEvent(new Event("pagehide"));

    await new Promise((r) => setTimeout(r, 5_000)); // past the 4s debounce
    expect(captureCalls).toBe(0);
  });

  // A beacon the browser refuses (queue full, payload over the ~64KB cap) must
  // leave the rows queued, or the edits are lost with no retry anywhere.
  it("keeps the rows queued when the browser refuses the beacon", async () => {
    beaconWorks = false;
    const c = useGearList();
    await c.load({ token: TOKEN });
    setVaultDecisionFor(TOKEN, "yes");
    c.updateItem("i1", { qty: 2 });
    await new Promise((r) => setTimeout(r, 200));
    window.dispatchEvent(new Event("pagehide"));

    expect(beacons).toHaveLength(1); // it was attempted
    // ...and the debounced POST still goes, because nothing was cleared
    await vi.waitFor(() => expect(captureCalls).toBe(1), { timeout: 8_000, interval: 50 });
    expect(captureBodies.at(-1)!.map((r) => r.name)).toEqual(["Duplex"]);
  });

  // The unanswered case: nothing has been queued, so there is nothing to send —
  // and a beacon here would be exactly the silent leak the prompt exists to stop.
  it("beacons nothing for a list whose question is still open", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    c.updateItem("i1", { qty: 2 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());

    window.dispatchEvent(new Event("pagehide"));
    expect(beacons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Category templates — cloning a whole vault folder back into a list.
//
// Driven through the live controller rather than a extracted helper because the
// behaviour under test is a COMPOSITION: addVaultFolder mints a folder, then leans
// on addVaultItem for every row, and the rules worth pinning (which rows are
// skipped, where they land, what a no-op does) only exist once those two run
// together against a real snapshot.
// ---------------------------------------------------------------------------
describe("useGearList — addVaultFolder", () => {
  const entry = (over: Partial<VaultEntry> & { normKey: string; name: string }): VaultEntry => ({
    id: 1,
    weightMg: 100_000,
    timesSeen: 1,
    lastUsedAt: "",
    createdAt: "",
    ...over,
  });

  beforeEach(() => {
    records.clear();
    storage.clear();
    resetVaultCapture();
    // a list that already HOLDS something, so the "already added" rule has a case
    listResponse = withGear([gear()]);
  });
  afterEach(() => {
    useGearList().dispose();
  });

  it("creates one folder and files every entry into it", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    const before = c.snapshot.value!.folders.length;

    const id = c.addVaultFolder("Cook kit", [
      entry({ normKey: "pot", name: "Pot", weightMg: 120_000 }),
      entry({ normKey: "stove", name: "Stove", weightMg: 80_000 }),
    ]);

    expect(id).not.toBe("");
    const snap = c.snapshot.value!;
    expect(snap.folders).toHaveLength(before + 1);
    const folder = snap.folders.find((f) => f.id === id)!;
    expect(folder.name).toBe("Cook kit");
    // base is the folder default — a template must not pin a classification the
    // vault row didn't carry
    expect(folder.defaultClassification).toBe("base");

    const landed = snap.items.filter((i) => i.folderId === id);
    expect(landed.map((i) => i.name).sort()).toEqual(["Pot", "Stove"]);
    expect(landed.map((i) => i.unitWeightMg).sort((a, b) => a - b)).toEqual([80_000, 120_000]);
  });

  it("skips gear the list already holds, matching the per-row rule", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    // the fixture list carries a Duplex; adding a category containing it must not
    // split one thing's weight across two rows
    const held = c.snapshot.value!.items[0]!;
    const id = c.addVaultFolder("Shelter", [
      entry({ normKey: vaultNormKey(held.brand, held.name, held.variant), name: held.name }),
      entry({ normKey: "stakes", name: "Stakes" }),
    ]);

    const landed = c.snapshot.value!.items.filter((i) => i.folderId === id);
    expect(landed.map((i) => i.name)).toEqual(["Stakes"]);
  });

  it("adds nothing at all when every entry is already held", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    const held = c.snapshot.value!.items[0]!;
    const folders = c.snapshot.value!.folders.length;

    const id = c.addVaultFolder("Shelter", [
      entry({ normKey: vaultNormKey(held.brand, held.name, held.variant), name: held.name }),
    ]);

    // an empty folder the user didn't ask for is worse than doing nothing
    expect(id).toBe("");
    expect(c.snapshot.value!.folders).toHaveLength(folders);
  });

  it("is a no-op for an empty category", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    const folders = c.snapshot.value!.folders.length;
    expect(c.addVaultFolder("Empty", [])).toBe("");
    expect(c.snapshot.value!.folders).toHaveLength(folders);
  });
});

// ---------------------------------------------------------------------------
// "Your lists" — the device registry the switcher actually reads
// ---------------------------------------------------------------------------
// The list switcher renders REGISTRY rows, not the open snapshot, so a
// rename is only as fast as the row behind it. It used to be updated from one
// place: the reply to a successful flush. In the live controller — the only place
// this shape exists — that put a debounce and a round trip between typing a name
// and reading it back, and dispose()'s parting flush made it worse than slow: it
// sends blind and drops the reply, so a rename typed on the way OUT of the editor
// never reached the row at all.
//
// The path that surfaces it is the ordinary one: duplicate a list, rename the copy
// to the trail you're actually packing for, open the switcher.
describe("useGearList — keeping 'Your lists' in step with a rename", () => {
  const rowFor = (token: string) =>
    useMyLists().entries.value.find((e) => e.editToken === token);

  beforeEach(async () => {
    records.clear();
    mutateCalls = 0;
    storage.clear();
    listResponse = snapshotFor("Timberline Trail (copy)"); // as a duplicate arrives
  });
  afterEach(() => {
    useGearList().dispose();
  });

  it("renames the row without waiting for the server", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    expect(rowFor(TOKEN)?.title).toBe("Timberline Trail (copy)");

    c.setMeta({ title: "Eagle Creek" });

    // Synchronously, with no mutate settled and none even sent yet — the reducer
    // here is the server's, so the row can be right before the wire agrees.
    expect(rowFor(TOKEN)?.title).toBe("Eagle Creek");
    expect(mutateCalls).toBe(0);
  });

  it("keeps the new name when the editor is left before the flush lands", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    c.setMeta({ title: "Eagle Creek" });
    await awaitMutateInFlight();

    c.dispose(); // straight back into the switcher to open something else

    expect(rowFor(TOKEN)?.title).toBe("Eagle Creek");
    settleMutate.resolve({ snapshot: snapshotFor("Eagle Creek", 2) });
  });

  // touch() is update-only for a reason — "Remove from device" has to stick — and
  // the optimistic call must not become the thing that quietly re-adds a row.
  it("does not resurrect a list removed from this device", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    useMyLists().forget(TOKEN);

    c.setMeta({ title: "Eagle Creek" });

    expect(rowFor(TOKEN)).toBeUndefined();
  });
});
