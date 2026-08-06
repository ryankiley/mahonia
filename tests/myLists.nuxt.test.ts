// @vitest-environment nuxt
//
// The device registry's ONE durability guarantee: what you do to it reaches
// localStorage. Needs a booted Nuxt because the thing under test is a Vue effect
// scope — the bug was not a decision any pure function makes, it was WHERE the
// persistence watcher got registered, which only exists once there's reactivity
// and a scope to register into. (See vitest.config.ts on why almost nothing else
// in tests/ opts into this environment.)
//
// The registry ref is a module singleton but useMyLists() is called from ordinary
// components, so the FIRST caller's effect scope used to own the watcher — and
// Vue stops a scope's watchers when it's disposed. In the app that first caller is
// the editor, and /mine is only reachable by leaving the editor: by the time you
// pressed "Remove from device" the writer was already gone, so the row left the
// screen, localStorage kept the entry, and the next load handed it back. A list
// you could not get rid of.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import type { MyListEntry } from "~~/shared/types";

// forget() also drops the list's on-device record; there's no IndexedDB here and
// this suite is about localStorage, so the store is a no-op that records nothing.
const deleted: string[] = [];
mockNuxtImport("useLocalListStore", () => () => ({
  get: async () => undefined,
  set: async () => {},
  del: async (key: string) => void deleted.push(key),
}));

// happy-dom ships a localStorage, but a Map-backed stub is clearable between cases
// and can't carry state in from another suite.
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
});

const STORAGE_KEY = "gear.mylists.v1";
const stored = (): MyListEntry[] => JSON.parse(storage.get(STORAGE_KEY) ?? "[]");

const entry = (editToken: string, title: string): MyListEntry => ({
  origin: "created",
  editToken,
  shareCode: "SNAPCODE0001",
  slug: "test-list-aaa111",
  title,
  totalMg: 0,
  version: 1,
  lastOpened: 1,
  displayUnit: "g",
});

describe("the device registry survives its first caller", () => {
  beforeEach(() => {
    storage.clear();
    deleted.length = 0;
  });

  it("still writes to localStorage after the scope that first used it is disposed", async () => {
    // A component mounts, reads the registry, and unmounts — the editor, in the
    // app. This is the ONLY call that constructs the singleton, so whatever scope
    // it happens to run in is the one the watcher would otherwise be tied to.
    const first = effectScope();
    first.run(() => useMyLists());
    first.stop();

    // A later page picks the same registry up and mutates it.
    const my = useMyLists();
    my.upsert(entry("token-a", "Sierra Trip"));
    await nextTick();
    expect(stored().map((e) => e.editToken)).toEqual(["token-a"]);

    // and the removal that used to go nowhere
    my.forget("token-a");
    await nextTick();
    expect(stored()).toEqual([]);
    expect(deleted).toEqual(["token-a"]);
  });

  it("keeps writing across several disposed scopes", async () => {
    const my = useMyLists();
    my.upsert(entry("token-b", "Desert Trip"));
    await nextTick();

    // every route change in the app disposes another scope; none of them owns the
    // writer, so the registry is still durable after all of them
    for (let i = 0; i < 3; i++) {
      const scope = effectScope();
      scope.run(() => useMyLists());
      scope.stop();
    }

    my.touch("token-b", { title: "Desert Trip, revised" });
    await nextTick();
    expect(stored()[0]?.title).toBe("Desert Trip, revised");

    my.forget("token-b");
    await nextTick();
    expect(stored()).toEqual([]);
  });
});
