// @vitest-environment nuxt
//
// "Your lists" holds one row per LIST, not one per edit token.
//
// Needs a Nuxt app for the same reason gearList.nuxt.test.ts does: useMyLists is a
// module singleton built out of auto-imported reactivity (`ref`, `watch`) over
// localStorage, and the thing under test is what the registry does to its own
// contents across a sequence of writes. Extracting a pure helper would be testing a
// shape that isn't the one shipping.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import type { ListSnapshot, MyListEntry } from "~~/shared/types";

// The real store is IndexedDB and there isn't one. Deletes are RECORDED rather than
// swallowed: "the row goes, the on-device copy stays" is the whole distinction
// between forget() and forgetSuperseded(), and it's only visible here.
const deleted: string[] = [];
mockNuxtImport("useLocalListStore", () => () => ({
  get: async () => undefined,
  set: async () => {},
  del: async (key: string) => void deleted.push(key),
}));

// Node's own localStorage global is inert without --localstorage-file (every method
// throws). A Map-backed stub is what the browser actually gives us, and the registry
// writes through it, so it's also how we check a collapse really landed on disk.
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
});

const SHARE = "LOOWIT000001";
const entry = (over: Partial<MyListEntry> & { editToken: string }): MyListEntry => ({
  origin: "created",
  shareCode: SHARE,
  slug: "ryans-loowit-aa11bb",
  title: "Ryan’s Loowit",
  totalMg: 5_000_000,
  version: 7,
  lastOpened: 1_700_000_000_000,
  displayUnit: "g",
  ...over,
});

const snapshotFor = (shareCode: string): ListSnapshot => ({
  shareCode,
  slug: "ryans-loowit-aa11bb",
  title: "Ryan’s Loowit",
  description: "",
  displayUnit: "g",
  folders: [],
  items: [],
  version: 8,
  isPublic: false,
});

// The singleton seeds from localStorage on its FIRST call and never re-reads, so
// tests drive the registry by writing entries.value rather than by reseeding storage.
function registry() {
  const my = useMyLists();
  return my;
}

beforeEach(() => {
  storage.clear();
  deleted.length = 0;
  registry().entries.value = [];
});
afterEach(() => {
  registry().entries.value = [];
});

describe("useMyLists — a list is its share code, not its edit token", () => {
  it("collapses a rotated list's leftover row onto the live token", async () => {
    const my = registry();
    // the state a rotate leaves behind when its forget() never reaches storage: the
    // dead token still in the registry, the new one arriving beside it
    my.entries.value = [entry({ editToken: "dead-token" })];

    my.upsert(entry({ editToken: "live-token", origin: "opened", version: 8 }));

    expect(my.entries.value).toHaveLength(1);
    expect(my.entries.value[0]!.editToken).toBe("live-token");
    expect(my.entries.value[0]!.version).toBe(8);

    // and the collapse is what gets written — not just what's on screen
    await nextTick();
    const stored = JSON.parse(storage.get("gear.mylists.v1")!) as MyListEntry[];
    expect(stored.map((e) => e.editToken)).toEqual(["live-token"]);
  });

  it("keeps 'created' through the collapse, so sign-in still claims the list", () => {
    const my = registry();
    my.entries.value = [entry({ editToken: "dead-token", origin: "created" })];

    // registerOpened marks a confirmed open "opened" — that must not launder a list
    // you made into one someone shared with you (useClaimedLists skips those)
    my.upsert(entry({ editToken: "live-token", origin: "opened" }));

    // asserted on the surviving row by token, not by position: with the old
    // token-only match the dead row was still there in front of it, "created" and all
    expect(my.entries.value).toHaveLength(1);
    expect(my.entries.value.find((e) => e.editToken === "live-token")!.origin).toBe("created");
  });

  it("keeps a pre-origin row claimable through a reopen of its own link", () => {
    const my = registry();
    // a registry row from before origin tracking existed (pre-accounts): no
    // `origin` key at all. The claim sweep counts these as created — the right
    // guess for nearly all of them (see useClaimedLists.claimDeviceLists).
    const legacy = entry({ editToken: "old-token" });
    delete (legacy as Partial<MyListEntry>).origin;
    my.entries.value = [legacy];

    // the standard cross-device move from the pre-accounts era: open your own
    // list through its full edit link. load() confirms the token, registerOpened
    // stamps the upsert "opened" — which must not overwrite the absent origin,
    // or this list silently leaves the claim sweep and the account never hears
    // of it (the machine that only reads the account then never shows it).
    my.upsert(entry({ editToken: "old-token", origin: "opened" }));

    expect(my.entries.value).toHaveLength(1);
    const row = my.entries.value[0]!;
    expect(row.origin).toBeUndefined();
    // the exact filter the claim sweep applies — the row must still pass it
    expect([row].filter((e) => e.origin !== "opened")).toHaveLength(1);
  });

  it("doesn't duplicate when a rotated list is reopened through registerCreated", () => {
    const my = registry();
    my.entries.value = [entry({ editToken: "dead-token" })];

    // the real call site: load() confirms the token against the server, then
    // registerOpened() hands the snapshot straight to registerCreated
    my.registerCreated({ editToken: "live-token", snapshot: snapshotFor(SHARE) }, 5_000_000, "opened");

    expect(my.entries.value).toHaveLength(1);
    expect(my.entries.value[0]!.editToken).toBe("live-token");
  });

  it("leaves other lists alone", () => {
    const my = registry();
    my.entries.value = [
      entry({ editToken: "dead-token" }),
      entry({ editToken: "helens-token", shareCode: "HELENS000001", title: "Ryan’s St. Helens" }),
    ];

    my.upsert(entry({ editToken: "live-token" }));

    expect(my.entries.value.map((e) => e.editToken).sort()).toEqual(["helens-token", "live-token"]);
  });

  it("never collapses share-code-less legacy entries into one row", () => {
    const my = registry();
    // pre-#54 lists lived at a bare /e#{token} and carry no share code; "" === "" must
    // not read as "the same list"
    my.entries.value = [
      entry({ editToken: "legacy-a", shareCode: "", title: "Old one" }),
      entry({ editToken: "legacy-b", shareCode: "", title: "Old two" }),
    ];

    my.upsert(entry({ editToken: "legacy-c", shareCode: "", title: "Old three" }));

    expect(my.entries.value).toHaveLength(3);
  });

  it("still updates in place when the same token comes back", () => {
    const my = registry();
    my.entries.value = [entry({ editToken: "live-token", title: "Ryan’s Loowit" })];

    my.upsert(entry({ editToken: "live-token", title: "Ryan’s Loowit (packed)" }));

    expect(my.entries.value).toHaveLength(1);
    expect(my.entries.value[0]!.title).toBe("Ryan’s Loowit (packed)");
  });
});

// The other side. upsert heals a duplicate when you open the LIVE row; this heals it
// when you open the dead one, which from the switcher looks identical.
describe("useMyLists.forgetSuperseded — the dead half of a rotate", () => {
  it("drops the dead row when another row holds the same list", async () => {
    const my = registry();
    my.entries.value = [entry({ editToken: "dead-token" }), entry({ editToken: "live-token" })];

    expect(my.forgetSuperseded("dead-token")).toBe(true);

    expect(my.entries.value.map((e) => e.editToken)).toEqual(["live-token"]);
    await nextTick();
    const stored = JSON.parse(storage.get("gear.mylists.v1")!) as MyListEntry[];
    expect(stored.map((e) => e.editToken)).toEqual(["live-token"]);
  });

  it("keeps the on-device copy — the page that opened it is still showing it", () => {
    const my = registry();
    my.entries.value = [entry({ editToken: "dead-token" }), entry({ editToken: "live-token" })];

    my.forgetSuperseded("dead-token");

    // forget() would have deleted it; a superseded row must not, because a second
    // tab may have kept editing under the dead token after the rotate
    expect(deleted).toEqual([]);
  });

  it("leaves a genuinely deleted list's row alone", () => {
    const my = registry();
    // one row for this list — a 404 here means the list is gone, and clearing it is
    // the editor's job (a confirm dialog explaining forget vs delete), not ours
    my.entries.value = [entry({ editToken: "only-token" })];

    expect(my.forgetSuperseded("only-token")).toBe(false);
    expect(my.entries.value).toHaveLength(1);
  });

  it("won't treat two share-code-less legacy rows as the same list", () => {
    const my = registry();
    my.entries.value = [
      entry({ editToken: "legacy-a", shareCode: "" }),
      entry({ editToken: "legacy-b", shareCode: "" }),
    ];

    expect(my.forgetSuperseded("legacy-a")).toBe(false);
    expect(my.entries.value).toHaveLength(2);
  });

  it("is a no-op for a token that isn't in the registry", () => {
    const my = registry();
    my.entries.value = [entry({ editToken: "live-token" })];

    expect(my.forgetSuperseded("never-heard-of-it")).toBe(false);
    expect(my.entries.value).toHaveLength(1);
  });
});
