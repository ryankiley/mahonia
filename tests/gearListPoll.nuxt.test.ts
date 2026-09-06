import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import type { LocalListRecord } from "~~/shared/localList";
import type { ListSnapshot } from "~~/shared/types";

// The live-sync poll's cadence. It follows the list's own activity: 3 s while the
// list is live, 10 s after two quiet minutes, 30 s after ten — and any sign of life
// (a field taking focus here; an edit and an adopted remote change take the same
// path) snaps it back, while the tab coming back into view polls at once. The clock
// is faked, so two quiet hours cost nothing; the poll endpoint records the faked time
// of every call and the assertions read the gaps between them.

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
// no vault on this device, so opening a list asks nothing about its gear
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(false),
  vaultKnown: ref(true),
  vaultFetch: async () => ({}),
}));

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
});

const TOKEN = "poll-test-token";
const snapshot = (): ListSnapshot => ({
  shareCode: "POLLCODE0001",
  slug: "poll-list-aaa111",
  title: "Poll",
  description: "",
  displayUnit: "g",
  folders: [],
  items: [],
  version: 1,
  isPublic: false,
});
registerEndpoint("/api/edit/list", () => ({ snapshot: snapshot() }));
let polls: number[] = [];
registerEndpoint("/api/edit/changes", () => {
  polls.push(Date.now());
  return { version: 1 };
});

const gaps = () => polls.slice(1).map((t, i) => t - polls[i]!);
const MIN = 60_000;

// The clock is faked but the mocked endpoint answers through the real event loop, so
// a fake-clock advance that fires a tick can't also deliver that tick's response.
// Advance in steps no larger than the cadence under test, and let real time pass
// between them so each poll has answered before the next timer is due.
const realSetTimeout = globalThis.setTimeout;
const settle = () => new Promise((r) => realSetTimeout(r, 5));
async function pass(ms: number, step: number) {
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - t));
    await settle();
  }
}

// document.hidden is a prototype getter in happy-dom; an own property shadows it
let hidden = false;
Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });

describe("useGearList — the live-sync poll's cadence", () => {
  beforeEach(() => {
    records.clear();
    polls = [];
    hidden = false;
    vi.useFakeTimers();
  });
  afterEach(() => {
    useGearList().dispose();
    vi.useRealTimers();
  });

  it("polls every 3 s while the list is live, then stretches to 10 s and 30 s as it sits", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    expect(polls).toHaveLength(0);

    // live: opening the list counts as a sign of life for two minutes
    await pass(2 * MIN, 3_000);
    expect(polls).toHaveLength(40);
    expect(new Set(gaps())).toEqual(new Set([3_000]));

    // quiet for two minutes: the tick at 2:00 schedules the next 10 s out
    polls = [];
    await pass(8 * MIN, 10_000);
    expect(polls.length).toBeGreaterThanOrEqual(40);
    expect(new Set(gaps())).toEqual(new Set([10_000]));

    // quiet for ten: 30 s
    polls = [];
    await pass(5 * MIN, 30_000);
    expect(polls.length).toBeGreaterThanOrEqual(8);
    expect(new Set(gaps())).toEqual(new Set([30_000]));
  });

  it("snaps back to 3 s when a field takes focus", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    await pass(2 * MIN, 3_000);
    await pass(10 * MIN, 10_000);
    polls = [];
    await pass(2 * MIN, 30_000);
    expect(new Set(gaps())).toEqual(new Set([30_000]));

    // a sign of life: the already-scheduled tick keeps its slot, every one after it is fast
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    polls = [];
    await pass(30_000, 30_000); // the slot the idle tick already held
    await pass(4 * 3_000, 3_000);
    expect(polls.length).toBeGreaterThanOrEqual(4);
    expect(new Set(gaps().slice(1))).toEqual(new Set([3_000]));
    field.remove();
  });

  it("sleeps while the tab is hidden and polls the moment it comes back", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    hidden = true;
    await pass(MIN, 3_000);
    expect(polls).toHaveLength(0);

    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(polls).toHaveLength(1);
    // ...and it is live again from there
    await pass(3_000, 3_000);
    expect(polls).toHaveLength(2);
  });

  it("stops for good on dispose — no tick outlives the session that started it", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    await pass(3_000, 3_000);
    expect(polls).toHaveLength(1);
    c.dispose();
    await pass(5 * MIN, 3_000);
    expect(polls).toHaveLength(1);
  });
});
