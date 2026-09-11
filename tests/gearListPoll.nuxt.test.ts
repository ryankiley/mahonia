import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage } from "./helpers/storage";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import type { LocalListRecord } from "~~/shared/localList";
import type { ListSnapshot } from "~~/shared/types";

// The live-sync poll's cadence. It follows the list's own activity: 3 s while the
// list is live, 10 s after two quiet minutes, 30 s after ten — and every sign of life
// the controller recognises snaps it back: a field taking focus, a local edit, a
// change adopted from elsewhere. The tab coming back into view, or the network,
// polls at once. Two guards are pinned as well: a tick queued by a list that has
// since been replaced must exit rather than poll for the new one, and a wake that
// lands while a request is in flight must neither start a second request nor be lost.
// The clock is faked, so two quiet hours cost nothing; the poll endpoint records the
// faked time of every call and the assertions read the gaps between them.

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

const storage = stubLocalStorage();

const TOKEN = "poll-test-token";
const OTHER_TOKEN = "poll-test-other-token";
const snapshot = (version = 1, title = "Poll"): ListSnapshot => ({
  shareCode: "POLLCODE0001",
  slug: "poll-list-aaa111",
  title,
  description: "",
  displayUnit: "g",
  folders: [],
  items: [],
  version,
  isPublic: false,
});
registerEndpoint("/api/edit/list", () => ({ snapshot: snapshot() }));
registerEndpoint("/api/edit/mutate", { method: "POST", handler: () => ({ snapshot: snapshot(2) }) });

let polls: number[] = [];
// what the next poll answers: a newer snapshot once (`newer`), or nothing until the
// test releases it (`hold` → `release`)
let newer: ListSnapshot | null = null;
let hold = false;
let release: (() => void) | null = null;
registerEndpoint("/api/edit/changes", () => {
  polls.push(Date.now());
  const answer = newer ? { version: newer.version, snapshot: newer } : { version: 1 };
  newer = null;
  if (!hold) return answer;
  hold = false;
  return new Promise((resolve) => {
    release = () => resolve(answer);
  });
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
/** Let the chain run until a tick is in flight (held by the endpoint). */
async function untilHeld() {
  hold = true;
  while (!release) await pass(1_000, 1_000);
}
/** Answer the held tick, let the response land, and let anything it scheduled
 *  for "now" fire. */
async function releaseHeld() {
  release?.();
  release = null;
  await settle();
  await vi.advanceTimersByTimeAsync(0);
  await settle();
}

// document.hidden is a prototype getter in happy-dom; an own property shadows it
let hidden = false;
Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });

/** Open a list and let it sit quiet long enough to reach the 30 s cadence. */
async function openAndIdle() {
  const c = useGearList();
  await c.load({ token: TOKEN });
  await pass(2 * MIN, 3_000);
  await pass(10 * MIN, 10_000);
  polls = [];
  await pass(2 * MIN, 30_000);
  expect(new Set(gaps())).toEqual(new Set([30_000]));
  return c;
}

describe("useGearList — the live-sync poll's cadence", () => {
  beforeEach(() => {
    records.clear();
    polls = [];
    newer = null;
    hold = false;
    release = null;
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

    // live: opening the list counts as a sign of life for two minutes — 40 ticks
    await pass(2 * MIN, 3_000);
    expect(polls).toHaveLength(40);
    expect(new Set(gaps())).toEqual(new Set([3_000]));

    // quiet for two minutes: the tick at 2:00 schedules the next 10 s out — 48 ticks
    // in the eight minutes to the ten-minute mark
    polls = [];
    await pass(8 * MIN, 10_000);
    expect(polls).toHaveLength(48);
    expect(new Set(gaps())).toEqual(new Set([10_000]));

    // quiet for ten: 30 s — 10 ticks in five minutes
    polls = [];
    await pass(5 * MIN, 30_000);
    expect(polls).toHaveLength(10);
    expect(new Set(gaps())).toEqual(new Set([30_000]));
  });

  it("snaps back to 3 s when a field takes focus", async () => {
    await openAndIdle();
    // a sign of life: the already-scheduled tick keeps its slot, every one after it is fast
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    polls = [];
    await pass(30_000, 30_000); // the slot the idle tick already held
    await pass(4 * 3_000, 3_000);
    expect(polls).toHaveLength(5);
    expect(new Set(gaps().slice(1))).toEqual(new Set([3_000]));
    field.remove();
  });

  it("snaps back to 3 s on a local edit", async () => {
    const c = await openAndIdle();
    c.setMeta({ title: "Edited while idle" });
    polls = [];
    await pass(30_000, 30_000); // the idle tick's slot; the edit's flush lands inside it
    await pass(4 * 3_000, 3_000);
    expect(polls).toHaveLength(5);
    expect(new Set(gaps().slice(1))).toEqual(new Set([3_000]));
  });

  it("snaps back to 3 s when a change arrives from elsewhere", async () => {
    const c = await openAndIdle();
    newer = snapshot(2, "Renamed elsewhere");
    polls = [];
    await pass(30_000, 30_000); // the idle tick adopts the newer snapshot...
    expect(c.snapshot.value?.title).toBe("Renamed elsewhere");
    await pass(4 * 3_000, 3_000); // ...and the chain is quick again
    expect(polls).toHaveLength(5);
    expect(new Set(gaps().slice(1))).toEqual(new Set([3_000]));
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

  it("polls the moment the network comes back", async () => {
    await openAndIdle();
    window.dispatchEvent(new Event("offline"));
    polls = [];
    await pass(2 * MIN, 30_000);
    expect(polls).toHaveLength(0); // nothing to pull while the connection is down

    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(polls).toHaveLength(1);
    await pass(3_000, 3_000);
    expect(polls).toHaveLength(2); // and quick again
  });

  it("a wake during an in-flight request starts no second one, and still polls at once after", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    await untilHeld();
    const inFlightAt = polls.length;
    hidden = true;
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await pass(2_000, 1_000);
    expect(polls).toHaveLength(inFlightAt); // the wake waited for the request
    await releaseHeld();
    expect(polls).toHaveLength(inFlightAt + 1); // ...then polled immediately
    await pass(3_000, 3_000);
    expect(polls).toHaveLength(inFlightAt + 2); // one chain, 3 s apart
  });

  it("a tick in flight at dispose does not outlive the session", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    await untilHeld();
    const before = polls.length;
    c.dispose();
    await releaseHeld();
    await pass(5 * MIN, 3_000);
    expect(polls).toHaveLength(before);
  });

  it("a tick queued by a replaced list does not poll for the new one", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    await untilHeld();
    // the old list's request is still out when another list takes the controller
    await c.load({ token: OTHER_TOKEN });
    await releaseHeld();
    polls = [];
    await pass(9_000, 3_000);
    // one chain, the new list's — the old tick did not add a second
    expect(polls).toHaveLength(3);
    expect(new Set(gaps())).toEqual(new Set([3_000]));
  });

  it("stops for good on dispose", async () => {
    const c = useGearList();
    await c.load({ token: TOKEN });
    await pass(3_000, 3_000);
    expect(polls).toHaveLength(1);
    c.dispose();
    await pass(5 * MIN, 3_000);
    expect(polls).toHaveLength(1);
  });
});
