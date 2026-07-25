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
import type { ListSnapshot } from "~~/shared/types";

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
registerEndpoint("/api/edit/list", () => ({ snapshot: snapshotFor("Original") }));
registerEndpoint("/api/edit/changes", () => ({ version: 1 })); // the live-sync poll
registerEndpoint("/api/catalog/use", () => ({})); // fire-and-forget ranking ping

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
