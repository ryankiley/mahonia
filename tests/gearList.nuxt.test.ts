// The ONE suite here that needs a Nuxt app booted. Everything else in tests/ is
// plain TS on the node environment and should stay that way — see vitest.config.ts.
//
// Why this can't be plain TS: what is under test isn't a decision a pure function
// makes, it's an ORDERING hazard between side effects that only exist inside the live
// controller — a batch out in a request, dispose() and later edits writing the
// on-device record, and the request settling after both. A helper extracted for
// testability would be exercising a different shape than the one that breaks. So: boot
// Nuxt, stub the two boundaries (the fetch and the IndexedDB store), and drive the real
// singleton through the real sequence.
//
// Real timers, but not the real waits: the 4 s capture debounce, the 450 ms flush
// debounce and the 1.5 s retry backoff are each shortened through the seam the
// composable exports for it. Six cases wait out the capture debounce, and at 4 s that
// was 34 of this file's 41 s — the reason it was the first file to time out under
// load. The cases that must act INSIDE that debounce (the pagehide cases below) wait
// for the rows to be queued rather than sleeping a guessed interval, which is what
// lets it be as short as it is.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage } from "./helpers/storage";
import { gear, snapshotFor as baseSnapshot } from "./helpers/list";
import { memoryListStore } from "./helpers/gearList";
import { vaultRow } from "./helpers/vault";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { createError, readBody } from "h3";
import { DRAFT_KEY, localKey, type LocalListRecord } from "~~/shared/localList";
import { tidyListText, type Op } from "~~/shared/ops";
import { computeTotals } from "~~/shared/weights";
import type { Folder, Item, ListSnapshot } from "~~/shared/types";
import type { VaultEntry } from "~~/shared/vault";
import { vaultNormKey } from "~~/shared/vault";
import { addVaultKit } from "~/composables/useVaultUnfold";
import { _setFlushBackoff, _setFlushDebounce } from "~/composables/useGearList";
import {
  _pendingCapture,
  _setCaptureDebounce,
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
// mutable, so a case can drive a sign-in without leaving the list
const hasVault = ref(true);
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault,
  vaultKnown: ref(true),
  // Options spelled out rather than `Parameters<typeof $fetch>[1]`: taking
  // Parameters of a generic instantiates it, which drags Nuxt's typed-route
  // matcher into every file that mocks this and blows TypeScript's depth limit
  // (see the same note in useVaultAccess itself).
  // Mirrors the real vaultFetch, including WHY it casts: `$fetch` is generic over
  // the app's routes, so typing the call drags Nuxt's route matcher in and blows
  // TypeScript's depth limit from a mock (see useVaultAccess).
  vaultFetch: <T,>(url: string, opts?: Record<string, unknown>) => {
    const call = $fetch as unknown as (u: string, o: unknown) => Promise<unknown>;
    return call(url, { ...opts, credentials: "same-origin" }) as Promise<T>;
  },
}));

mockNuxtImport("useLocalListStore", () => () => memoryListStore(records));

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

const storage = stubLocalStorage();

// see the header: the real wait is 4 s, and the pagehide cases wait for the rows to
// be queued and then act inside it. Module scope, because the controller is a module
// singleton and vitest gives this file its own process. The two negative margins
// below (`CAPTURE_DEBOUNCE_MS + 500`) stay generous on purpose: under load a timer
// fires late, never early.
const CAPTURE_DEBOUNCE_MS = 300;
_setCaptureDebounce(CAPTURE_DEBOUNCE_MS);
// the flush behind every dispatch, and the first retry after a failed one — every
// case here waits out the first, and one waits out the second
_setFlushDebounce(20);
_setFlushBackoff(300);

// ---- the network --------------------------------------------------------------
const TOKEN = "test-edit-token";
const snapshotFor = (title: string, version = 1): ListSnapshot =>
  baseSnapshot({ shareCode: "SNAPCODE0001", slug: "test-list-aaa111", title, version });
// The open list as the vault's answer knows it: held by a link, filed by share code.
const LIST = { editToken: TOKEN, shareCode: "SNAPCODE0001" };
// The answer's two keys, under whichever name they are filed: the share code now, the
// edit token before.
const isAnswerKey = (k: string) => /^gear\.vault\.(answer|declined|for|not)\./.test(k);
const answerKeys = () => [...storage.keys()].filter(isAnswerKey);

// Routes go through registerEndpoint, NOT a $fetch global stub: under the Nuxt
// environment $fetch is already bound to test-utils' own mock, which 404s anything
// unregistered — a plain vi.stubGlobal never gets a look in (the controller just
// reports the list "missing" and no flush is ever attempted).
// What /api/edit/list hands back. A `let` because the vault-prompt suite below
// needs lists with actual gear in them (an empty one has nothing to capture, so it
// could never raise the question).
let listResponse: ListSnapshot = snapshotFor("Original");
// set to make the read fail the way a dropped connection does (not a 404)
let listFails = false;
registerEndpoint("/api/edit/list", () => {
  if (listFails) throw createError({ statusCode: 503 });
  return { snapshot: listResponse };
});
registerEndpoint("/api/edit/changes", () => ({ version: 1 })); // the live-sync poll
registerEndpoint("/api/catalog/use", () => ({})); // fire-and-forget ranking ping
// What My Gear holds of the keys the open list asks about, as [normKey, weightMg]
// tuples. `heldGear` is what these cases pretend the vault has; empty by default,
// because they are about capture and an empty vault makes every row a genuine one.
let heldGear: [string, number | null][] = [];
let amongCalls = 0;
let amongFails = false;
registerEndpoint("/api/vault/among", {
  method: "POST",
  handler: async (event) => {
    amongCalls++;
    if (amongFails) throw createError({ statusCode: 503 });
    const body = await readBody<{ normKeys?: string[] }>(event);
    const asked = new Set(body?.normKeys ?? []);
    return { keys: heldGear.filter(([k]) => asked.has(k)) };
  },
});

let captureCalls = 0;
// what each capture actually carried — the picker tests assert on the ROWS, not
// just that a write happened
let captureBodies: { name: string }[][] = [];
// The REAL response shape, not a convenient stand-in. The old stub answered
// `{ vaultToken }` — a shape the endpoint has never returned — so `res.keys` was
// always undefined here and the client's contract was never compared against the
// server's. That is exactly how a `string[]` where the client destructured
// `[key, weight]` tuples reached main-adjacent code with a green suite: every
// successful save reported itself as refused. The stub now echoes what
// captureVaultItemsReporting returns.
registerEndpoint("/api/vault/capture", { method: "POST", handler: async (event) => {
  captureCalls++;
  const body = await readBody<{ items?: { name: string; normKey: string; weightMg: number }[] }>(event);
  const items = body?.items ?? [];
  captureBodies.push(items);
  return { ok: true, captured: items.length, keys: items.map((i) => [i.normKey, i.weightMg]) };
} });

// The link a rotate mints. A constant, because the one thing the rotate tests
// need from the endpoint is that the token CHANGES.
const ROTATED_TOKEN = "rotated-edit-token";
// A draft's first save. Echoes what it was sent, the way the server builds the list from
// the body; `createGate`, when set, holds the answer until the case settles it.
let createGate: Promise<void> | null = null;
let createCalls = 0;
registerEndpoint("/api/lists/create", {
  method: "POST",
  handler: async (event) => {
    createCalls++;
    const body = await readBody<{ title?: string; data: Pick<ListSnapshot, "folders" | "items"> }>(event);
    if (createGate) await createGate;
    return {
      editToken: "created-edit-token",
      snapshot: baseSnapshot({
        shareCode: "CREATED00001",
        slug: "created-list-ccc333",
        title: body.title ?? "Untitled list",
        folders: body.data.folders,
        items: body.data.items,
      }),
    };
  },
});

// Open by default; a case that needs the answer to land late sets a gate and opens it.
let rotateGate: Promise<void> | null = null;
registerEndpoint("/api/edit/rotate", {
  method: "POST",
  handler: async () => {
    if (rotateGate) await rotateGate;
    return { editToken: ROTATED_TOKEN };
  },
});

// The mutate is left hanging until the test settles it by hand — that pending window
// IS the bug's window, and controlling it is the whole point.
let mutateCalls = 0;
type Settle = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
let settleMutate: Settle;
// every request in the order it arrived, with the ops it carried — for the cases
// where two are out at once and each has to be settled on its own
let mutates: (Settle & { ops: Op[] })[] = [];
registerEndpoint("/api/edit/mutate", {
  method: "POST",
  handler: async (event) => {
    const { ops } = await readBody<{ ops: Op[] }>(event);
    mutateCalls++;
    return new Promise((resolve, reject) => {
      settleMutate = { resolve, reject };
      mutates.push({ ops, resolve, reject });
    });
  },
});

// flush() is debounced behind a dispatch (20 ms here, see the seam above) and isn't
// exported, so the test waits for the request to actually leave rather than reaching
// inside.
const awaitMutateInFlight = () =>
  vi.waitFor(() => expect(mutateCalls).toBe(1), { timeout: 5_000, interval: 25 });

// How the cases start. Each is one step further along than the last: the controller
// with a list loaded; that list with the vault's question raised by an edit; and a
// two-piece list taken past "Add" to the chooser.
const opened = async (token = TOKEN) => {
  const c = useGearList();
  await c.load({ token });
  return c;
};
const prompted = async () => {
  const c = await opened();
  c.updateItem("i1", { qty: 2 });
  await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());
  return c;
};
const choosing = async () => {
  listResponse = withGear([gear(), gear({ id: "i2", name: "Kakwa 55", brand: "Durston" })]);
  const c = await prompted();
  await c.answerVaultPrompt(true);
  await vi.waitFor(() => expect(c.vaultPicker.value).not.toBeNull());
  return c;
};

/** The "Your lists" row filed under an edit link. */
const rowFor = (token: string) =>
  useMyLists().entries.value.find((e) => e.editToken === token);

// Every dial above, back to its rest position before each case — the superset of what
// the five suites below each used to reset for themselves. Each suite then sets only
// the list it serves. Clearing a dial a suite never touches costs nothing and means a
// case cannot inherit another suite's state through a dial nobody thought to list.
beforeEach(() => {
  records.clear();
  listFails = false;
  rotateGate = null;
  createGate = null;
  createCalls = 0;
  storage.clear(); // the decision store
  resetVaultCapture(); // the capture memo is module-scoped
  mutateCalls = 0;
  mutates = [];
  captureCalls = 0;
  captureBodies = [];
  beacons.length = 0;
  beaconWorks = true;
  heldGear = []; // the vault's answer is not module-scoped — it lives on the open list
  amongCalls = 0;
  amongFails = false;
  hasVault.value = true;
});
afterEach(() => {
  // the controller is a module singleton: hand it back clean, and stop its poll
  useGearList().dispose();
});

describe("useGearList — a batch still out when the editor moved on", () => {
  beforeEach(() => {
    listResponse = snapshotFor("Original");
  });

  const failed = () => createError({ statusCode: 500, statusMessage: "network" });
  const queued = () => records.get(localKey(TOKEN))?.pending;
  // long enough for a settled request's continuation to run, before asserting that it
  // wrote nothing
  const settled = () => new Promise((r) => setTimeout(r, 50));

  // The rule this suite holds: the on-device record keeps every op the server has not
  // acknowledged to the list that is open. A batch out in a request is still in the
  // queue, so leaving mid-flight writes it to the record with everything else, and
  // nothing has to be put back when the request then fails.
  it("keeps the in-flight ops in that list's on-device record", async () => {
    const c = await opened();
    c.setMeta({ title: "Renamed while leaving" });

    await awaitMutateInFlight();

    // the SPA navigation lands mid-flight
    c.dispose();
    await vi.waitFor(() => expect(queued()).toMatchObject([{ t: "setMeta" }]));

    // ...and only THEN does the request fail (the connection that dropped is often
    // why they left)
    settleMutate.reject(failed());
    await settled();

    expect(queued()).toMatchObject([{ t: "setMeta", patch: { title: "Renamed while leaving" } }]);
    expect(records.get(localKey(TOKEN))?.snapshot.title).toBe("Renamed while leaving");
    // the batch already out was not sent a second time on the way out
    expect(mutateCalls).toBe(1);
  });

  // The answer to a batch that lands after the editor left is never read, so the record
  // cannot know it landed. It stays queued and goes again on the next open, which the
  // server takes: an add is idempotent by id and an update sets an absolute value.
  it("replays a batch that landed after the editor left on the next open", async () => {
    const c = await opened();
    c.setMeta({ title: "Renamed while leaving" });

    await awaitMutateInFlight();
    c.dispose();
    settleMutate.resolve({ snapshot: snapshotFor("Renamed while leaving", 2) });
    await settled();
    expect(queued()).toMatchObject([{ t: "setMeta", patch: { title: "Renamed while leaving" } }]);

    listResponse = snapshotFor("Renamed while leaving", 2);
    await c.load({ token: TOKEN });
    await vi.waitFor(() => expect(mutateCalls).toBe(2), { timeout: 5_000, interval: 25 });
    expect(mutates[1]!.ops).toMatchObject([{ t: "setMeta", patch: { title: "Renamed while leaving" } }]);
  });

  // An edit queued BEHIND the batch in flight. Leaving sends it on its own (the batch
  // ahead of it is already out), and when both requests fail the record still holds
  // both, in the order they were made.
  it("keeps an edit queued behind the in-flight batch when both requests fail", async () => {
    const c = await opened();
    c.setMeta({ title: "T1" });
    await awaitMutateInFlight();
    c.setMeta({ description: "D2" });

    c.dispose();
    await vi.waitFor(() => expect(mutateCalls).toBe(2), { timeout: 5_000, interval: 25 });
    expect(mutates[1]!.ops).toMatchObject([{ t: "setMeta", patch: { description: "D2" } }]);

    mutates[1]!.reject(failed());
    mutates[0]!.reject(failed());
    await settled();
    expect(queued()).toMatchObject([
      { t: "setMeta", patch: { title: "T1" } },
      { t: "setMeta", patch: { description: "D2" } },
    ]);

    // the server saw neither; the next open puts both back
    await c.load({ token: TOKEN });
    expect(c.snapshot.value).toMatchObject({ title: "T1", description: "D2" });
  });

  // No leaving at all: a later edit's write to the device, made while a batch is out,
  // carries that batch too — a tab killed there has lost nothing. Once the batch is
  // acknowledged it leaves the queue, and only the later edit goes in the next request.
  it("writes the in-flight batch with a later edit, and drops it once acknowledged", async () => {
    const c = await opened();
    c.setMeta({ title: "T1" });
    await awaitMutateInFlight();
    c.setMeta({ description: "D2" });

    await vi.waitFor(() =>
      expect(records.get(localKey(TOKEN))?.snapshot.description).toBe("D2"),
    );
    expect(queued()).toMatchObject([
      { t: "setMeta", patch: { title: "T1" } },
      { t: "setMeta", patch: { description: "D2" } },
    ]);

    settleMutate.resolve({ snapshot: snapshotFor("T1", 2) });
    await vi.waitFor(() => expect(mutateCalls).toBe(2), { timeout: 5_000, interval: 25 });
    expect(mutates[1]!.ops).toMatchObject([{ t: "setMeta", patch: { description: "D2" } }]);
    await vi.waitFor(() =>
      expect(queued()).toMatchObject([{ t: "setMeta", patch: { description: "D2" } }]),
    );
    // the edit made mid-flight still stands on the adopted snapshot
    expect(c.snapshot.value).toMatchObject({ title: "T1", description: "D2" });
  });

  // And the ordinary failure path — still on the same list: the batch stays queued in
  // memory for the retry, and on the device.
  it("retries the batch when the failure happens on the list still open", async () => {
    const c = await opened();
    c.setMeta({ title: "Renamed in place" });

    await awaitMutateInFlight();
    settleMutate.reject(createError({ statusCode: 500, statusMessage: "boom" }));

    await vi.waitFor(() => {
      const rec = records.get(localKey(TOKEN));
      expect(rec?.pending).toHaveLength(1);
      expect(rec?.pending[0]).toMatchObject({ t: "setMeta" });
    });
    // The op is still in the in-memory queue: flush() only fires when `pending` is
    // non-empty, so a second attempt is the proof.
    // (Deliberately NOT asserting status === "error" here — the failure sets it, then
    // the retry sets "saving" a backoff later, so that assertion races the very retry
    // this behaviour is for.)
    await vi.waitFor(() => expect(mutateCalls).toBe(2), { timeout: 5_000, interval: 25 });
  });

  // A 200 that carries no list (a middlebox answering for the server) acknowledges
  // nothing: the batch stays queued and goes again after the backoff.
  it("keeps the batch queued when a 200 answer carries no snapshot, and sends it again", async () => {
    const c = await opened();
    c.setMeta({ title: "Renamed in place" });

    await awaitMutateInFlight();
    settleMutate.resolve({});

    await vi.waitFor(() => expect(mutateCalls).toBe(2), { timeout: 5_000, interval: 25 });
    expect(mutates[1]!.ops).toMatchObject([{ t: "setMeta", patch: { title: "Renamed in place" } }]);
    expect(queued()).toMatchObject([{ t: "setMeta", patch: { title: "Renamed in place" } }]);
  });

  // A batch out under the old link when this device replaces it comes back 404: the
  // link it went under is dead, not the list. It goes again under the new one, where
  // it used to mark the list gone and stop queueing every edit after it.
  it("sends a batch refused under a link replaced mid-flight again, rather than calling the list gone", async () => {
    const c = await opened();
    c.setMeta({ title: "Renamed during a rotate" });
    await awaitMutateInFlight();
    expect(await c.rotate()).toBe(ROTATED_TOKEN);
    settleMutate.reject(createError({ statusCode: 404 }));
    await vi.waitFor(() => expect(mutateCalls).toBe(2), { timeout: 5_000, interval: 25 });
    expect(c.status.value).not.toBe("missing");
  });

  it("still calls the list gone on a 404 under the link it holds", async () => {
    const c = await opened();
    c.setMeta({ title: "Renamed after it went" });
    await awaitMutateInFlight();
    settleMutate.reject(createError({ statusCode: 404 }));
    await vi.waitFor(() => expect(c.status.value).toBe("missing"));
  });
});

// The server applies an op after its trip through JSON, where a key holding undefined
// is gone and NaN is null. The editor applies, queues and stores that same form, so
// the list on screen is the one the server will answer with.
describe("useGearList — an edit applies here as it will on the server", () => {
  it("leaves a day's distance standing when the patch names it as undefined", async () => {
    listResponse = { ...snapshotFor("Original"), days: [{ id: "d1", sortOrder: 0, distanceM: 12_000 }] };
    const c = await opened();
    expect(c.snapshot.value?.days?.[0]?.distanceM).toBe(12_000);
    c.updateDay("d1", { distanceM: undefined });
    expect(c.snapshot.value?.days?.[0]?.distanceM).toBe(12_000);
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
    listResponse = withGear([gear()]);
  });

  it("asks before a single row of someone else's gear reaches the vault", async () => {
    const c = await prompted();
    expect(vaultDecisionFor(LIST)).toBe("ask");
    // and it is still only a question — nothing has been sent (this window is well
    // inside the capture debounce either way, but the guard returns before anything
    // is even queued)
    expect(captureCalls).toBe(0);
    // the rows' mirror of the answer agrees: unanswered is not covered, so every
    // row's save button stays a live action
    expect(c.vaultAuto.value).toBe(false);
  });

  // Opening a list writes nothing to it. A water row stored with a count before the
  // reducer folded one reads back folded (tidyListText, on the server's reads and on the
  // device copy's), so there is no fix for the open to send — and nothing an open sends
  // can capture a shared list's gear before its owner's gear is in question.
  const countedWater = () =>
    withGear([
      gear(),
      gear({ id: "i3", name: "Water", brand: undefined, qty: 3, unitWeightMg: 3_000_000, classification: "consumable" }),
    ]);
  const onDevice = (snapshot: ListSnapshot) =>
    records.set(localKey(TOKEN), { snapshot, pending: [], updatedAt: 1 });

  it("reads a stored water count off the device copy folded, weighing what it did", async () => {
    onDevice(countedWater());
    listFails = true; // the device copy is all there is
    const c = await opened();
    expect(c.status.value).toBe("offline");
    expect(c.snapshot.value?.items.find((i) => i.id === "i3")).toMatchObject({ qty: 1, unitWeightMg: 9_000_000 });
    expect(c.totals.value?.totalMg).toBe(computeTotals(countedWater()).totalMg);
  });

  it("sends no write, and captures nothing, on opening such a list", async () => {
    onDevice(countedWater());
    // the server reads its row through the same tidy
    listResponse = tidyListText(countedWater());
    const c = await opened();
    expect(c.snapshot.value?.items.find((i) => i.id === "i3")).toMatchObject({ qty: 1, unitWeightMg: 9_000_000 });
    await new Promise((r) => setTimeout(r, 100)); // past the flush debounce
    expect(mutateCalls).toBe(0);
    expect(records.get(localKey(TOKEN))?.pending).toEqual([]);
    expect(c.vaultPrompt.value).toBeNull();
    expect(captureCalls).toBe(0);
  });

  // A question whose answer changes nothing, asked once and never again, is worse
  // than no question: it burns the one chance to ask about this list.
  it("never asks about a list with no gear in it", async () => {
    listResponse = withGear([gear({ unitWeightMg: 0, brand: undefined, name: "Notes to self" })]);
    const c = await opened();
    c.updateItem("i1", { qty: 2 });

    await new Promise((r) => setTimeout(r, 50)); // let the dynamic import settle
    expect(c.vaultPrompt.value).toBeNull();
    expect(vaultDecisionFor(LIST)).toBe("ask");
  });

  it("takes yes for an answer, captures, and stops asking", async () => {
    const c = await prompted();

    // one row, so no chooser — but answering is async now (it has to build the
    // capture set before it knows whether there's anything to choose between)
    await c.answerVaultPrompt(true);
    expect(c.vaultPrompt.value).toBeNull();
    expect(vaultDecisionFor(LIST)).toBe("yes");
    // ...and the rows learn it the same moment: the automatic path now has this
    // list, so the save buttons flip to "already banked" without a reload
    expect(c.vaultAuto.value).toBe(true);

    // the capture is debounced behind the answer (CAPTURE_DEBOUNCE_MS here)
    await vi.waitFor(() => expect(captureCalls).toBe(1), { timeout: 8_000, interval: 50 });

    c.updateItem("i1", { qty: 3 });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.vaultPrompt.value).toBeNull();
  });

  // Dismissing IS answering — the whole point of the banner over a toast. "No" has
  // to outlive the tab, or every reload re-asks about a friend's list until one
  // stray tap lands on Add.
  it("takes dismissal for a no, and holds it across a reload", async () => {
    const c = await prompted();

    c.answerVaultPrompt(false);
    expect(c.vaultPrompt.value).toBeNull();
    expect(vaultDecisionFor(LIST)).toBe("no");
    expect(c.vaultAuto.value).toBe(false); // no cover claimed for a declined list

    c.updateItem("i1", { qty: 3 });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.vaultPrompt.value).toBeNull();

    // reload: a fresh controller on the same list, reading the same store
    c.dispose();
    const reopened = await opened();
    reopened.updateItem("i1", { qty: 4 });
    await new Promise((r) => setTimeout(r, 50));
    expect(reopened.vaultPrompt.value).toBeNull();
    expect(captureCalls).toBe(0);
  });

  // ---- what My Gear holds, of THIS list's gear ---------------------------
  //
  // This lived in an app-wide singleton once, with a test file of its own. Two
  // reviews of that shape produced 27 findings, about twenty of them consequences
  // of its lifetime — so the answer moved onto the open list, and its behaviour is
  // tested through the controller that owns it.

  it("asks the vault about the list it just opened, and only about that list's gear", async () => {
    const item = listResponse.items[0]!;
    const key = vaultNormKey(item.brand, item.name, item.variant);
    heldGear = [[key, item.unitWeightMg], ["something else entirely", 1_000]];
    const c = await opened();
    await vi.waitFor(() => expect(c.vaultGearAsked.value.has(key)).toBe(true));
    // the ask is scoped, so the answer is too — the vault's other gear is not here
    expect([...c.vaultGear.value.keys()]).toEqual([key]);
    expect(c.vaultGear.value.get(key)).toBe(item.unitWeightMg);
    expect(c.vaultGearSettled.value).toBe(true);
  });

  it("drops one list's answer when the next opens, without being told to", async () => {
    // THE reason this is per-list. An app-wide cache had to be told: an epoch to
    // tell one account's answer from the next, a reset hooked into sign-out, a
    // merge rule for a read racing a capture. State that dies with the list it
    // describes needs none of it.
    const item = listResponse.items[0]!;
    const key = vaultNormKey(item.brand, item.name, item.variant);
    heldGear = [[key, item.unitWeightMg]];
    const c = await opened();
    await vi.waitFor(() => expect(c.vaultGear.value.size).toBe(1));

    heldGear = [];
    listResponse = withGear([gear({ name: "Kakwa 55", brand: "Durston" })]);
    await c.load({ token: "another-edit-token" });
    expect(c.vaultGear.value.has(key)).toBe(false);
    await vi.waitFor(() => expect(c.vaultGearSettled.value).toBe(true));
    expect(c.vaultGear.value.size).toBe(0);
  });

  it("asks nothing at all when there is no vault to ask", async () => {
    hasVault.value = false;
    try {
      const c = await opened();
      await vi.waitFor(() => expect(c.vaultGearSettled.value).toBe(true));
      // settled as an ANSWER — nothing is banked, so every worthy row keeps its
      // button — and without a request, which is what keeps a visitor with no
      // account off this endpoint entirely
      expect(amongCalls).toBe(0);
      expect(c.vaultGearAsked.value.size).toBeGreaterThan(0);
      expect(c.vaultGear.value.size).toBe(0);
    } finally {
      hasVault.value = true;
    }
  });

  it("settles even when the ask fails, rather than holding every button back", async () => {
    // offline, rate-limited, a blip. A row waits only while its gear is
    // unanswered, so an ask that never settles is a save button hidden on every
    // row of every list with no way back.
    amongFails = true;
    const c = await opened();
    await vi.waitFor(() => expect(c.vaultGearSettled.value).toBe(true));
    expect(c.vaultGearAsked.value.size).toBeGreaterThan(0);
    expect(c.vaultGear.value.size).toBe(0);
  });

  it("re-asks when someone signs in without leaving the list", async () => {
    // The one thing a per-list answer cannot work out for itself, and finding #1
    // of the first review: signing in from the editor never navigates, so nothing
    // reopens the list. Without the controller's session watcher the rows would
    // still be rendering against the signed-out answer — every one of them
    // offering to save gear the new account banked months ago.
    hasVault.value = false;
    const item = listResponse.items[0]!;
    const key = vaultNormKey(item.brand, item.name, item.variant);
    const c = await opened();
    await vi.waitFor(() => expect(c.vaultGearSettled.value).toBe(true));
    expect(c.vaultGear.value.size).toBe(0);

    heldGear = [[key, item.unitWeightMg]];
    hasVault.value = true; // a passkey sign-in, same page, no navigation
    await vi.waitFor(() => expect(c.vaultGear.value.has(key)).toBe(true));
  });

  it("asks again about gear the list gains after it opened", async () => {
    // A row typed in later has no answer, so it would offer to save gear the
    // vault already holds — the original bug, in miniature, on rows added since.
    const c = await opened();
    await vi.waitFor(() => expect(c.vaultGearSettled.value).toBe(true));

    const late = vaultNormKey("Durston", "Kakwa 55", null);
    heldGear = [[late, 900_000]];
    const id = c.addBlankItem(c.snapshot.value!.folders[0]!.id);
    c.updateItem(id, { name: "Kakwa 55", brand: "Durston", unitWeightMg: 900_000 });
    await vi.waitFor(() => expect(c.vaultGear.value.get(late)).toBe(900_000), { timeout: 3_000 });
  });

  // The same proxy that made the save button lie also raises this question, and
  // the vault can now answer it: a list whose every row is already banked has
  // nothing to consent to and nothing to move.
  it("does not ask about a list whose gear My Gear already holds", async () => {
    const item = listResponse.items[0]!;
    // what the vault says when asked about this list: its one row, already banked
    heldGear = [[vaultNormKey(item.brand, item.name, item.variant), item.unitWeightMg]];
    const c = await opened();
    await vi.waitFor(() => expect(c.vaultGearAsked.value.size).toBeGreaterThan(0));
    c.updateItem("i1", { qty: 2 });
    await new Promise((r) => setTimeout(r, 50));
    // no modal over a list to request permission for a no-op — and, crucially,
    // the list's one chance to ask is NOT spent: the question stays open for gear
    // added later that the vault genuinely doesn't have
    expect(c.vaultPrompt.value).toBeNull();
    expect(vaultDecisionFor(LIST)).toBe("ask");
    expect(captureCalls).toBe(0);
  });

  it("still asks as soon as one row is gear the vault doesn't hold", async () => {
    heldGear = [["something else entirely", 1_000]]; // nothing this list carries
    const c = await opened();
    await vi.waitFor(() => expect(c.vaultGearAsked.value.size).toBeGreaterThan(0));
    c.updateItem("i1", { qty: 2 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());
  });

  // The question is about the list in front of you. Left standing after a
  // navigation it asks about the wrong gear — and, answered, spends the NEW list's
  // one chance to ask on a question that was never posed about it.
  it("does not carry an unanswered question onto the next list opened", async () => {
    const c = await prompted();

    // ...and off they go to their own list without answering
    c.dispose();
    listResponse = withGear([gear({ unitWeightMg: 0, brand: undefined, name: "Notes" })]);
    const mine = await opened("another-edit-token");
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
    const c = await choosing();
    expect(c.vaultPicker.value!.map((r) => r.name).sort()).toEqual(["Duplex", "Kakwa 55"]);
    // still nothing decided and nothing sent — opening the chooser is not answering
    expect(vaultDecisionFor(LIST)).toBe("ask");
    expect(captureCalls).toBe(0);
  });

  // The chooser is the same question, further along: the decision stays "ask" until it
  // is confirmed, so an edit behind it would otherwise raise the toast it came from.
  it("keeps the chooser up, with no prompt over it, when an edit lands behind it", async () => {
    const c = await choosing();

    c.updateItem("i1", { qty: 3 });
    await new Promise((r) => setTimeout(r, 20)); // sync's chunk load, then its decision
    expect(c.vaultPicker.value).not.toBeNull();
    expect(c.vaultPrompt.value).toBeNull();
  });

  it("captures only what was ticked, and never re-offers the rest", async () => {
    const c = await choosing();

    const mine = c.vaultPicker.value!.find((r) => r.name === "Duplex")!;
    c.confirmVaultPicker([mine.normKey]);
    expect(vaultDecisionFor(LIST)).toBe("yes");
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
    await new Promise((r) => setTimeout(r, CAPTURE_DEBOUNCE_MS + 500)); // past the capture debounce
    expect(captureBodies.flat().map((r) => r.name)).toEqual(["Duplex"]);
  });

  // Gear you add to a shared list AFTER choosing is the gear most likely to be
  // yours — an allow-list would have silently excluded it forever.
  it("still captures gear added after the choice", async () => {
    const c = await choosing();
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
    const c = await choosing();

    c.cancelVaultPicker();
    expect(c.vaultPicker.value).toBeNull();
    expect(vaultDecisionFor(LIST)).toBe("ask");

    c.updateItem("i1", { qty: 3 });
    await vi.waitFor(() => expect(c.vaultPrompt.value).not.toBeNull());
    expect(captureCalls).toBe(0);
  });

  // One row is not a choice. A dialog to tick the single thing you just said yes to
  // is a click that can only be answered one way.
  it("skips the chooser when there is only one piece of gear", async () => {
    listResponse = withGear([gear()]);
    const c = await prompted();

    await c.answerVaultPrompt(true);
    expect(c.vaultPicker.value).toBeNull();
    expect(vaultDecisionFor(LIST)).toBe("yes");
    await vi.waitFor(() => expect(captureCalls).toBe(1), { timeout: 8_000, interval: 50 });
  });

  // A list that arrived WHOLE — imported from LighterPack, cloned from a shared
  // list — captures at the moment it's created, because nothing else would ever
  // offer it. Recording the answer there is what stops the very next keystroke
  // asking whether the gear you just imported is really yours.
  it("never asks about a list this device just imported or cloned", async () => {
    useVaultCapture().captureNewList(withGear([gear()]), TOKEN);
    expect(vaultDecisionFor(LIST)).toBe("yes");

    const c = await opened();
    c.updateItem("i1", { qty: 2 });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.vaultPrompt.value).toBeNull();
  });

  // The answer is filed under the share code, which a rotate keeps — so a rotate,
  // the owner cycling a leaked link, has nothing to carry and nothing to clear.
  it("still has the vault answer — exclusions included — after a rotate that touched none of it", async () => {
    const c = await choosing();
    const mine = c.vaultPicker.value!.find((r) => r.name === "Duplex")!;
    c.confirmVaultPicker([mine.normKey]);
    const before = new Map(answerKeys().map((k) => [k, storage.get(k)]));

    const set = vi.spyOn(storage, "set");
    const del = vi.spyOn(storage, "delete");
    expect(await c.rotate()).toBe(ROTATED_TOKEN);
    const touched = [...set.mock.calls, ...del.mock.calls].map(([k]) => k).filter(isAnswerKey);
    set.mockRestore();
    del.mockRestore();
    expect(touched).toEqual([]);
    expect(new Map(answerKeys().map((k) => [k, storage.get(k)]))).toEqual(before);

    // the new link finds the same answer...
    const rotated = { editToken: ROTATED_TOKEN, shareCode: LIST.shareCode };
    expect(vaultDecisionFor(rotated)).toBe("yes");
    expect(vaultExclusionsFor(rotated).has(vaultNormKey("Durston", "Kakwa 55", undefined))).toBe(true);
    // ...the rows' mirror still says covered-except-the-declined-row...
    expect(c.vaultAuto.value).toBe(true);
    expect(c.vaultDeclined.value.has(vaultNormKey("Durston", "Kakwa 55", undefined))).toBe(true);

    // ...and the question, being answered, does not come back on the next edit
    c.updateItem("i1", { qty: 3 });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.vaultPrompt.value).toBeNull();
  });

  // A rotate on a never-answered list carries nothing and invents nothing: the
  // question stays open, and the prompt still comes.
  it("keeps an unanswered question open across a rotate", async () => {
    const c = await prompted();

    // navigating away and rotating from a fresh session ("ask" never recorded)
    expect(await c.rotate()).toBe(ROTATED_TOKEN);
    expect(vaultDecisionFor({ editToken: ROTATED_TOKEN, shareCode: LIST.shareCode })).toBe("ask");
    expect(c.vaultAuto.value).toBe(false);
  });

  // An edit link is a capability; a key name is readable by any script on the page
  // and lands in every storage dump. The answer is filed under the share code only.
  it("never writes the edit token into a storage key", async () => {
    const c = await choosing();
    c.confirmVaultPicker([c.vaultPicker.value!.find((r) => r.name === "Duplex")!.normKey]);
    expect(answerKeys().sort()).toEqual(["gear.vault.answer.SNAPCODE0001", "gear.vault.declined.SNAPCODE0001"]);
    expect([...storage.keys()].filter((k) => k.includes(TOKEN))).toEqual([]);
  });

  // An answer given before the move was filed under the edit token. Opening the list
  // moves it, once, so nobody is asked a question they already answered.
  it("moves an answer filed under the edit token onto the share code when the list opens", async () => {
    storage.set(`gear.vault.for.${TOKEN}`, "yes");
    storage.set(`gear.vault.not.${TOKEN}`, JSON.stringify(["stove"]));
    const c = await opened();
    expect(answerKeys().sort()).toEqual(["gear.vault.answer.SNAPCODE0001", "gear.vault.declined.SNAPCODE0001"]);
    expect(vaultDecisionFor(LIST)).toBe("yes");
    expect([...vaultExclusionsFor(LIST)]).toEqual(["stove"]);
    expect(c.vaultAuto.value).toBe(true);
    expect(c.vaultDeclined.value.has("stove")).toBe(true);

    c.updateItem("i1", { qty: 2 });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.vaultPrompt.value).toBeNull();
  });

  // Opening the next list starts with the last one's snapshot still in hand; the
  // move must wait for this list's own share code.
  it("moves the answer onto the list being opened, not the one before it", async () => {
    await opened();
    storage.set("gear.vault.for.another-edit-token", "no");
    listResponse = baseSnapshot({ shareCode: "OTHERCODE001", slug: "other-list-bbb222", title: "Another list" });
    await opened("another-edit-token");
    expect(answerKeys()).toEqual(["gear.vault.answer.OTHERCODE001"]);
  });

  it("keeps an answer already under the share code over an older one under the token", async () => {
    storage.set(`gear.vault.for.${TOKEN}`, "yes");
    storage.set("gear.vault.answer.SNAPCODE0001", "no");
    await opened();
    expect(vaultDecisionFor(LIST)).toBe("no");
    expect(storage.has(`gear.vault.for.${TOKEN}`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the last-chance flush
// ---------------------------------------------------------------------------
// Capture is debounced (4 s in the app; CAPTURE_DEBOUNCE_MS here) so typing a name
// is one write instead of one per keystroke — which means the common case (edit a
// list, close the tab) lands INSIDE the debounce with the rows still queued. pagehide is the only hook that
// reliably fires when mobile Safari backgrounds a tab, and a beacon is the only
// send that survives the document going away.
//
// "Inside the debounce" is asserted, not slept into: sync()'s dynamic import has to
// resolve before the rows are queued, so each case waits for `_pendingCapture()` and
// then acts, however long the import took on this machine.
const rowsQueued = () => vi.waitFor(() => expect(_pendingCapture()).toBe(true), { interval: 5 });

describe("useGearList — getting a pending capture out as the page goes away", () => {
  beforeEach(() => {
    listResponse = withGear([gear()]);
  });

  it("beacons the queued rows on pagehide, well inside the debounce", async () => {
    const c = await opened();
    setVaultDecisionFor(LIST, "yes"); // a list already known to be mine
    c.updateItem("i1", { qty: 2 });
    await rowsQueued();

    window.dispatchEvent(new Event("pagehide"));

    expect(beacons).toHaveLength(1);
    expect(beacons[0]!.url).toBe("/api/vault/capture");
    expect((beacons[0]!.body as { items: { name: string }[] }).items.map((i) => i.name)).toEqual([
      "Duplex",
    ]);
  });

  // Most visitors have no account, and the endpoint answers them with a 401. The
  // rows used to be built, queued, POSTed and refused on every edit, then beaconed
  // again on every tab-hide.
  it("queues nothing for a visitor who is signed out, and captures when they sign in", async () => {
    hasVault.value = false;
    try {
      const c = await opened();
      setVaultDecisionFor(LIST, "yes");
      c.updateItem("i1", { qty: 2 });
      await new Promise((r) => setTimeout(r, 50)); // past sync()'s import, were it running
      expect(_pendingCapture()).toBe(false);
      window.dispatchEvent(new Event("pagehide"));
      expect(beacons).toHaveLength(0);

      hasVault.value = true; // a passkey sign-in, same page, no edit after it
      await rowsQueued();
    } finally {
      hasVault.value = true;
    }
  });

  // A drag, a paste or an undo is one op per row, and each one notes a change: the
  // capture set is built once for the tick, from the list as the last op left it.
  it("builds one capture for a burst of edits, holding the last state", async () => {
    const c = await opened();
    setVaultDecisionFor(LIST, "yes");
    c.updateItem("i1", { qty: 2 });
    c.updateItem("i1", { name: "Triplex" });
    await rowsQueued();
    window.dispatchEvent(new Event("pagehide"));
    expect(beacons).toHaveLength(1);
    expect((beacons[0]!.body as { items: { name: string }[] }).items.map((i) => i.name)).toEqual(["Triplex"]);
  });

  // Belt and braces: having beaconed the rows, the debounce must not then send
  // them a second time if the page turns out to still be alive (a backgrounded
  // tab that comes back).
  it("does not also POST what it already beaconed", async () => {
    const c = await opened();
    setVaultDecisionFor(LIST, "yes");
    c.updateItem("i1", { qty: 2 });
    await rowsQueued();
    window.dispatchEvent(new Event("pagehide"));

    await new Promise((r) => setTimeout(r, CAPTURE_DEBOUNCE_MS + 500)); // past the debounce
    expect(captureCalls).toBe(0);
  });

  // A beacon the browser refuses (queue full, payload over the ~64KB cap) must
  // leave the rows queued, or the edits are lost with no retry anywhere.
  it("keeps the rows queued when the browser refuses the beacon", async () => {
    beaconWorks = false;
    const c = await opened();
    setVaultDecisionFor(LIST, "yes");
    c.updateItem("i1", { qty: 2 });
    await rowsQueued();
    window.dispatchEvent(new Event("pagehide"));

    expect(beacons).toHaveLength(1); // it was attempted
    // ...and the debounced POST still goes, because nothing was cleared
    await vi.waitFor(() => expect(captureCalls).toBe(1), { timeout: 8_000, interval: 50 });
    expect(captureBodies.at(-1)!.map((r) => r.name)).toEqual(["Duplex"]);
  });

  // The unanswered case: nothing has been queued, so there is nothing to send —
  // and a beacon here would be exactly the silent leak the prompt exists to stop.
  it("beacons nothing for a list whose question is still open", async () => {
    const c = await prompted();

    window.dispatchEvent(new Event("pagehide"));
    expect(beacons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A kit from My Gear, onto a list — and taken back off with one Undo.
// ---------------------------------------------------------------------------
describe("useGearList — addVaultKit", () => {
  const entry = (over: Partial<VaultEntry> & { id: number; normKey: string; name: string }): VaultEntry =>
    vaultRow({ weightMg: 100_000, ...over });
  const pot = entry({ id: 1, normKey: "pot", name: "Pot", weightMg: 120_000 });
  const lighter = entry({ id: 2, normKey: "lighter", name: "Lighter", weightMg: 11_000 });
  const kit = entry({
    id: 3,
    normKey: "cook kit",
    name: "Cook kit",
    kind: "kit",
    ownWeightMg: 20_000,
    weightMg: 142_000,
    parts: [
      { id: 1, qty: 1, name: "Pot", weightMg: 120_000 },
      { id: 2, qty: 2, name: "Lighter", weightMg: 11_000 },
    ],
  });

  beforeEach(() => {
    listResponse = withGear([gear()]);
  });

  it("lands the kit as a group at its own weight, its items under it at their counts", async () => {
    const c = await opened();
    const id = addVaultKit(c, kit, null, [pot, lighter, kit]);
    const items = c.snapshot.value!.items;
    expect(items.find((i) => i.id === id)).toMatchObject({ name: "Cook kit", unitWeightMg: 20_000 });
    expect(items.filter((i) => i.parentId === id).map((i) => [i.name, i.qty])).toEqual([["Pot", 1], ["Lighter", 2]]);
  });

  // the pane's add and a name-field pick are one rule (vaultRowFields): the pane used
  // to drop the unit the piece reads in on /gear, which the pick carried
  it("adds a piece from My Gear in its own unit, as a name-field pick does", async () => {
    const c = await opened();
    const id = c.addVaultItem(entry({ id: 9, normKey: "mug", name: "Mug", weightMg: 107_700, entryUnit: "oz" }), null);
    expect(c.snapshot.value!.items.find((i) => i.id === id)).toMatchObject({ name: "Mug", unitWeightMg: 107_700, entryUnit: "oz", weightOverridden: true });
  });

  it("offers an undo that takes the whole group back off", async () => {
    const c = await opened();
    const before = c.snapshot.value!.items.length;
    const id = addVaultKit(c, kit, null, [pot, lighter, kit]);
    c.offerUndoAdd("Cook kit", id);
    expect(c.pendingUndo.value).toMatchObject({ label: "Cook kit", verb: "Added" });
    c.undoRemove();
    expect(c.snapshot.value!.items).toHaveLength(before);
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
  beforeEach(() => {
    listResponse = snapshotFor("Timberline Trail (copy)"); // as a duplicate arrives
  });

  it("renames the row without waiting for the server", async () => {
    const c = await opened();
    expect(rowFor(TOKEN)?.title).toBe("Timberline Trail (copy)");

    c.setMeta({ title: "Eagle Creek" });

    // Synchronously, with no mutate settled and none even sent yet — the reducer
    // here is the server's, so the row can be right before the wire agrees.
    expect(rowFor(TOKEN)?.title).toBe("Eagle Creek");
    expect(mutateCalls).toBe(0);
  });

  it("keeps the new name when the editor is left before the flush lands", async () => {
    const c = await opened();
    c.setMeta({ title: "Eagle Creek" });
    await awaitMutateInFlight();

    c.dispose(); // straight back into the switcher to open something else

    expect(rowFor(TOKEN)?.title).toBe("Eagle Creek");
    settleMutate.resolve({ snapshot: snapshotFor("Eagle Creek", 2) });
  });

  // touch() is update-only for a reason — "Remove from device" has to stick — and
  // the optimistic call must not become the thing that quietly re-adds a row.
  it("does not resurrect a list removed from this device", async () => {
    const c = await opened();
    useMyLists().forget(TOKEN);

    c.setMeta({ title: "Eagle Creek" });

    expect(rowFor(TOKEN)).toBeUndefined();
  });

  // The row shows a name and a unit, never a weight, so a weight edit is no reason to
  // rewrite the whole registry to storage on every keystroke.
  it("leaves the registry alone for an edit that only moves the weight", async () => {
    listResponse = withGear([gear()]);
    const c = await opened();
    const registry = useMyLists().entries.value;

    c.updateItem("i1", { unitWeightMg: 600_000 });

    expect(c.totals.value?.totalMg).toBe(600_000);
    expect(useMyLists().entries.value).toBe(registry);
  });
});

// ---------------------------------------------------------------------------
// a rotate that lands after the editor moved on
// ---------------------------------------------------------------------------
// "Replace link" is a round trip, and nothing stops the switcher being used while it's
// out. The answer is about the list that asked; the list on screen by then must keep
// its own link, and the rotated one must keep its new link (its old one is dead).
describe("useGearList — a rotate that lands after the editor moved on", () => {
  const OTHER = "other-edit-token";

  it("leaves the list now open alone, and keeps the rotated list's new link", async () => {
    listResponse = snapshotFor("Rotated list");
    const c = await opened();
    await vi.waitFor(() => expect(records.get(localKey(TOKEN))?.snapshot.title).toBe("Rotated list"));

    let land!: () => void;
    rotateGate = new Promise((r) => (land = r));
    const rotating = c.rotate();

    // the switcher, mid-flight — to a different list, with its own share code
    listResponse = baseSnapshot({ shareCode: "OTHERCODE001", slug: "other-list-bbb222", title: "Another list" });
    await c.load({ token: OTHER });
    land();

    // nothing for the screen: its address and toast belong to a list that's gone
    expect(await rotating).toBeNull();
    // the open list still writes with its own link, and its row and copy survive
    expect(c.editToken).toBe(OTHER);
    expect(rowFor(OTHER)?.title).toBe("Another list");
    // the rotated list kept the only link that still opens it...
    expect(rowFor(ROTATED_TOKEN)?.title).toBe("Rotated list");
    expect(rowFor(TOKEN)).toBeUndefined();
    // ...and its on-device copy moved with it
    await vi.waitFor(() => expect(records.get(localKey(ROTATED_TOKEN))?.snapshot.title).toBe("Rotated list"));
    expect(records.has(localKey(TOKEN))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// a draft whose first save fails
// ---------------------------------------------------------------------------
describe("useGearList — a draft whose first save fails", () => {
  it("doesn't replay what was typed during the failed save over what was typed after", async () => {
    const c = useGearList();
    c.startDraft();
    const id = c.addBlankItem(null);

    // the first real content starts the create; hold it, and make it fail
    let fail!: (e: unknown) => void;
    createGate = new Promise((_, reject) => (fail = reject));
    c.updateItem(id, { name: "Duplex" });
    c.updateItem(id, { unitWeightMg: 100_000 }); // typed while the create is out
    fail(createError({ statusCode: 503 }));
    await vi.waitFor(() => expect(c.status.value).toBe("error"));

    // the correction, after the failure: it starts the next create itself
    createGate = null;
    c.updateItem(id, { unitWeightMg: 200_000 });
    await vi.waitFor(() => expect(c.editToken).toBe("created-edit-token"));

    // the list is created holding the correction, and nothing puts the old value back
    expect(c.snapshot.value?.items.find((i) => i.id === id)?.unitWeightMg).toBe(200_000);
    await new Promise((r) => setTimeout(r, 60)); // past the flush debounce
    expect(mutateCalls).toBe(0);
  });

  // The create can answer once the editor has gone elsewhere (another list, /gear). The
  // list exists by then, and that answer holds its only edit link.
  it("keeps the list a late first save made, in Your lists", async () => {
    useMyLists().forget("created-edit-token"); // the case above made one by this token
    const c = useGearList();
    c.startDraft();
    const id = c.addBlankItem(null);
    let land!: () => void;
    createGate = new Promise((resolve) => (land = () => resolve()));
    c.updateItem(id, { name: "Duplex" });
    await new Promise((r) => setTimeout(r, 20));
    c.dispose(); // the editor moves on while the create is out
    land();
    await vi.waitFor(() => expect(useMyLists().entries.value.some((e) => e.editToken === "created-edit-token")).toBe(true));
    // and the draft that made it is let go, so the next New list doesn't make it twice
    await vi.waitFor(() => expect(records.has(DRAFT_KEY)).toBe(false));
  });
});

// ---------------------------------------------------------------------------
// a draft saved because one of its links was asked for
// ---------------------------------------------------------------------------
// The first-real-content rule keeps a visitor who only looked from leaving a row
// behind. Asking for a link is not looking: saveDraft makes the list whatever it holds.
describe("useGearList — a draft saved because its link was asked for", () => {
  beforeEach(() => {
    useMyLists().forget("created-edit-token"); // an earlier case made one by this token
  });

  it("saves a list with nothing in it, title and all", async () => {
    const c = useGearList();
    c.startDraft();
    c.setMeta({ title: "Loowit, August" });
    await new Promise((r) => setTimeout(r, 60)); // a title alone still saves nothing
    expect(createCalls).toBe(0);

    expect(await c.saveDraft()).toBe(true);
    expect(c.editToken).toBe("created-edit-token");
    expect(c.snapshot.value?.shareCode).toBe("CREATED00001");
    expect(c.snapshot.value?.title).toBe("Loowit, August");
    expect(c.snapshot.value?.items).toEqual([]);
    // and it is a list like any other from here: in Your lists, off the draft slot
    expect(useMyLists().entries.value.some((e) => e.editToken === "created-edit-token")).toBe(true);
    expect(records.has(DRAFT_KEY)).toBe(false);
  });

  it("waits on a first save already out instead of making the list twice", async () => {
    const c = useGearList();
    c.startDraft();
    let land!: () => void;
    createGate = new Promise((resolve) => (land = () => resolve()));
    c.updateItem(c.addBlankItem(null), { name: "Duplex" }); // real content: the create leaves
    await vi.waitFor(() => expect(createCalls).toBe(1));

    const asked = c.saveDraft();
    land();
    expect(await asked).toBe(true);
    expect(createCalls).toBe(1);
  });

  it("is a no-op on a list that is already saved", async () => {
    const c = useGearList();
    c.startDraft();
    expect(await c.saveDraft()).toBe(true);
    expect(await c.saveDraft()).toBe(true);
    expect(createCalls).toBe(1);
  });

  it("answers false when the save fails, and leaves an empty draft as it was", async () => {
    const c = useGearList();
    c.startDraft();
    createGate = Promise.reject(createError({ statusCode: 503 }));
    createGate.catch(() => {}); // the handler awaits it; this only quiets the unhandled warning
    expect(await c.saveDraft()).toBe(false);
    expect(c.editToken).toBe("");
    // nothing is unsaved by the content rule: no "Not saved", and no retry behind it
    expect(c.status.value).toBe("synced");
    await new Promise((r) => setTimeout(r, 400)); // past the 300 ms backoff
    expect(createCalls).toBe(1);

    // asking again is the retry
    createGate = null;
    expect(await c.saveDraft()).toBe(true);
  });

  it("answers false offline without trying", async () => {
    const c = useGearList();
    c.startDraft();
    window.dispatchEvent(new Event("offline"));
    try {
      expect(await c.saveDraft()).toBe(false);
      expect(createCalls).toBe(0);
    } finally {
      window.dispatchEvent(new Event("online"));
    }
  });

  it("answers false when the editor moved on before the save landed", async () => {
    const c = useGearList();
    c.startDraft();
    let land!: () => void;
    createGate = new Promise((resolve) => (land = () => resolve()));
    const asked = c.saveDraft();
    await vi.waitFor(() => expect(createCalls).toBe(1));
    c.startDraft(); // New list, while the create is out
    land();
    expect(await asked).toBe(false); // this draft has no link; the one saved is in Your lists
    expect(c.editToken).toBe("");
  });
});
