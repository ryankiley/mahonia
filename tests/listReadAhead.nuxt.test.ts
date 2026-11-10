// Switching lists without the flash: the editor page reads the incoming list's
// on-device copy before the editor mounts (readAhead), and load() takes that read
// instead of awaiting its own — so the list is on the controller in the same tick the
// load starts, and the new editor's first render has it. Without that, the editor
// rendered for a frame or more with no list: a topbar holding only the switcher and
// "Loading…" where the list goes.
//
// The REAL store runs here, with only IndexedDB's request stubbed: the slot's rules
// (once, for its key, dropped by a write to that key) are the store's, and a double
// would be testing itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { quietVaultAccess } from "./helpers/gearList";
import { snapshotFor } from "./helpers/list";
import { stubLocalStorage } from "./helpers/storage";
import { localKey, type LocalListRecord } from "~~/shared/localList";
import { readAhead } from "~/composables/useGearList";
import { useLocalListStore } from "~/composables/useLocalListStore";

// IndexedDB, as the one request the store makes of it: the answer lands a macrotask
// later (`delay.ms` of real time), the way a real request's success event does.
const idb = vi.hoisted(() => ({ disk: new Map<string, unknown>(), delay: { ms: 0 }, reads: 0 }));
vi.mock("~~/shared/idb", () => ({
  idbRequest: (_n: string, _v: number, _s: string, _m: string, run: (s: unknown) => { result: unknown }) =>
    new Promise((resolve) => {
      const req = run({
        get: (k: string) => (idb.reads++, { result: structuredClone(idb.disk.get(k)) }),
        put: (v: unknown, k: string) => (idb.disk.set(k, v), { result: k }),
        delete: (k: string) => (idb.disk.delete(k), { result: undefined }),
      });
      setTimeout(() => resolve(req.result), idb.delay.ms);
    }),
}));
// the store stands down where there is no IndexedDB at all, and this environment has none
vi.stubGlobal("indexedDB", {});

mockNuxtImport("useVaultAccess", () => () => quietVaultAccess());
stubLocalStorage();

const TOKEN = "read-ahead-token";
const record = (title: string): LocalListRecord => ({
  snapshot: snapshotFor({ shareCode: "AHEAD0000001", slug: "ahead-aaa111", title }),
  pending: [],
  updatedAt: 1,
});
// the server's copy, so a load that reaches the network has something to adopt
registerEndpoint("/api/edit/list", () => ({ snapshot: record("On the server").snapshot }));
registerEndpoint("/api/edit/changes", () => ({ version: 1 }));

beforeEach(() => {
  idb.disk.clear();
  idb.delay.ms = 0;
  idb.reads = 0;
  useLocalListStore().take(""); // empty the slot a case may have left
});
afterEach(() => useGearList().dispose());

describe("the held read", () => {
  it("is handed over once, to the load for its key", async () => {
    const store = useLocalListStore();
    idb.disk.set("a", record("A"));
    await store.prefetch("a");
    expect(store.take("a")?.landed?.record?.snapshot.title).toBe("A");
    expect(store.take("a")).toBeUndefined();
  });

  it("is dropped by a take for another key", async () => {
    const store = useLocalListStore();
    idb.disk.set("a", record("A"));
    await store.prefetch("a");
    expect(store.take("b")).toBeUndefined();
    expect(store.take("a")).toBeUndefined();
  });

  it("is dropped by a write to its key, so it can't serve a copy older than the device's", async () => {
    const store = useLocalListStore();
    idb.disk.set("a", record("A"));
    await store.prefetch("a");
    void store.set("a", record("A, edited"));
    expect(store.take("a")).toBeUndefined();
  });

  it("is handed over in flight when it hasn't landed, rather than read twice", async () => {
    const store = useLocalListStore();
    idb.disk.set("a", record("A"));
    idb.delay.ms = 30;
    void store.prefetch("a");
    const held = store.take("a");
    expect(held?.landed).toBeUndefined();
    expect((await held?.read)?.snapshot.title).toBe("A");
    expect(idb.reads).toBe(1);
  });
});

describe("load() after the page read ahead", () => {
  const route = { hash: `#${TOKEN}`, params: { code: "AHEAD0000001" } };

  it("has the list in the same tick it starts", async () => {
    idb.disk.set(localKey(TOKEN), record("On device"));
    await readAhead(route);
    const c = useGearList();
    void c.load({ token: TOKEN });
    // no await between the call and this line: what the editor's first render sees
    expect(c.snapshot.value?.title).toBe("On device");
    expect(c.status.value).toBe("synced");
  });

  it("without it, starts with nothing — the frame that flashed", async () => {
    idb.disk.set(localKey(TOKEN), record("On device"));
    const c = useGearList();
    const loading = c.load({ token: TOKEN });
    expect(c.snapshot.value).toBeNull();
    expect(c.status.value).toBe("loading");
    await loading;
    expect(c.snapshot.value?.title).toBe("On the server");
  });

  it("awaits a read that outran the page's wait, without reading again", async () => {
    idb.disk.set(localKey(TOKEN), record("On device"));
    idb.delay.ms = 400; // past the page's 250 ms hold
    await readAhead(route);
    const c = useGearList();
    const loading = c.load({ token: TOKEN });
    expect(c.snapshot.value).toBeNull();
    await vi.waitUntil(() => c.snapshot.value, { timeout: 1000 });
    await loading;
    expect(idb.reads).toBe(1);
  });

  it("reads nothing for a bare code without a session to open it by", async () => {
    await readAhead({ hash: "", params: { code: "AHEAD0000001" } });
    expect(idb.reads).toBe(0);
  });
});
