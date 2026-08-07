// @vitest-environment nuxt
//
// The controller's CLAIMED-OPEN path: a list held by share code + session, with no
// edit token on this device (the phone side of "made on the Mac, opened on the
// phone"). Its own file rather than more cases in gearList.nuxt.test.ts because
// these endpoints must READ the auth headers — which capability a request carried
// is the thing under test — and registerEndpoint fixtures are file-global.
//
// What has to hold, and is pinned here:
//   • a code-open talks to the server with X-List-Code and NEVER a bearer;
//   • it is not a draft — editing it must never reach /api/lists/create (that
//     failure mode silently duplicates a real list);
//   • it never mints a device-registry row (the claimed switcher row is the
//     handle), and its on-device copy lives under the code: key;
//   • a rotate graduates it to the token path: bearer from then on, a registry
//     row minted, the code-keyed record gone;
//   • a rename reaches the claimed-lists state the switcher renders (touchByCode).
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { createError, getHeader, readBody, type H3Event } from "h3";
import { claimedLocalKey, type LocalListRecord } from "~~/shared/localList";
import { LIST_CODE_HEADER } from "~~/shared/links";
import type { ListSnapshot } from "~~/shared/types";
import type { Op } from "~~/shared/ops";

// ---- boundary stubs (same shape as gearList.nuxt.test.ts) ---------------------
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
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(false), // the vault is not this file's subject; keep capture quiet
  vaultFetch: <T,>() => Promise.resolve({} as T),
}));

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
});

// ---- the network, capability-aware ---------------------------------------------
const CODE = "TESTC0DE0001"; // canonical Crockford — normalizes to itself
const snapshotFor = (title: string, version = 1): ListSnapshot => ({
  shareCode: CODE,
  slug: "claimed-list-aaa111",
  title,
  description: "",
  displayUnit: "g",
  folders: [],
  items: [],
  version,
  isPublic: false,
});

interface SeenAuth {
  bearer: string | undefined;
  listCode: string | undefined;
}
const authOf = (event: H3Event): SeenAuth => ({
  bearer: getHeader(event, "authorization"),
  listCode: getHeader(event, LIST_CODE_HEADER),
});

let listAuth: SeenAuth[] = [];
let serverList: ListSnapshot = snapshotFor("Alpine Loop");
// When set, the open is refused the way editAuth refuses a lapsed session or an
// unclaimed code — the client-side half of that contract is a test below.
let refuseOpens = false;
registerEndpoint("/api/edit/list", (event) => {
  listAuth.push(authOf(event));
  if (refuseOpens) throw createError({ statusCode: 401, statusMessage: "Missing edit capability" });
  return { snapshot: serverList };
});

let mutateAuth: (SeenAuth & { ops?: Op[] })[] = [];
registerEndpoint("/api/edit/mutate", {
  method: "POST",
  handler: async (event) => {
    const seen: SeenAuth & { ops?: Op[] } = authOf(event);
    mutateAuth.push(seen);
    const body = await readBody<{ ops?: Op[] }>(event);
    seen.ops = body?.ops;
    // echo the ops onto the snapshot the way the reducer would for the one op
    // these tests send (setMeta title), so the controller adopts a truthful merge
    const rename = body?.ops?.findLast((o) => o.t === "setMeta");
    if (rename && "patch" in rename && typeof rename.patch.title === "string")
      serverList = { ...serverList, title: rename.patch.title };
    serverList = { ...serverList, version: serverList.version + 1 };
    return { snapshot: serverList };
  },
});

registerEndpoint("/api/edit/changes", () => ({ version: serverList.version }));
registerEndpoint("/api/catalog/use", () => ({}));

const ROTATED_TOKEN = "rotated-edit-token";
let rotateAuth: SeenAuth[] = [];
registerEndpoint("/api/edit/rotate", {
  method: "POST",
  handler: (event) => {
    rotateAuth.push(authOf(event));
    return { editToken: ROTATED_TOKEN };
  },
});

// The tripwire. A claimed open that ever falls into the draft path creates a
// second list out of a real one — the exact hazard dispatch()'s guard exists for.
let createCalls = 0;
registerEndpoint("/api/lists/create", {
  method: "POST",
  handler: () => {
    createCalls++;
    return { editToken: "never-minted", snapshot: snapshotFor("Duplicate") };
  },
});

const flushed = () =>
  vi.waitFor(() => expect(mutateAuth.length).toBeGreaterThan(0), { timeout: 5_000, interval: 25 });

describe("useGearList — a claimed open (share code + session, no token held)", () => {
  beforeEach(() => {
    records.clear();
    storage.clear();
    listAuth = [];
    mutateAuth = [];
    rotateAuth = [];
    createCalls = 0;
    serverList = snapshotFor("Alpine Loop");
    useMyLists().entries.value = [];
    useClaimedLists().lists.value = [
      { shareCode: CODE, slug: "claimed-list-aaa111", title: "Alpine Loop", totalMg: 0, version: 1, displayUnit: "g", updatedAt: "2026-08-07T00:00:00.000Z" },
    ];
  });
  afterEach(() => {
    useGearList().dispose();
  });

  it("opens with X-List-Code and no bearer, and adopts the server snapshot", async () => {
    const c = useGearList();
    await c.load({ code: CODE });

    expect(listAuth).toHaveLength(1);
    expect(listAuth[0]).toEqual({ bearer: undefined, listCode: CODE });
    expect(c.snapshot.value?.title).toBe("Alpine Loop");
    expect(c.status.value).toBe("synced");
    expect(c.openedByCode.value).toBe(true);
    expect(c.editToken).toBe("");
  });

  it("normalizes a sloppy code once, everywhere: header, storage key, state", async () => {
    const c = useGearList();
    // lowercase with O for 0 — what a hand-typed /e/{code} URL can deliver
    await c.load({ code: CODE.toLowerCase().replace(/0/g, "o") });

    expect(listAuth[0]!.listCode).toBe(CODE);
    c.setMeta({ title: "Renamed" });
    await vi.waitFor(() => expect(records.has(claimedLocalKey(CODE))).toBe(true));
  });

  it("never registers a device row — the claimed switcher row is the handle", async () => {
    const c = useGearList();
    await c.load({ code: CODE });
    expect(useMyLists().entries.value).toHaveLength(0);
  });

  it("edits flush through the code header and NEVER reach the draft-create path", async () => {
    const c = useGearList();
    await c.load({ code: CODE });
    c.setMeta({ title: "Renamed on the phone" });

    await flushed();
    expect(mutateAuth[0]).toMatchObject({ bearer: undefined, listCode: CODE });
    // the hazard case: a code-open mistaken for a draft would have minted a
    // duplicate list here instead of (or as well as) mutating the real one
    expect(createCalls).toBe(0);
    await vi.waitFor(() => expect(c.status.value).toBe("synced"));
    expect(c.snapshot.value?.version).toBe(2);
  });

  it("mirrors a rename onto the claimed row the switcher reads", async () => {
    const c = useGearList();
    await c.load({ code: CODE });
    c.setMeta({ title: "Wind River Loop" });

    // the optimistic mirror lands with the dispatch, before any round-trip
    expect(useClaimedLists().lists.value[0]!.title).toBe("Wind River Loop");
    await flushed();
  });

  it("keeps the on-device copy under the code: key, queue included", async () => {
    const c = useGearList();
    await c.load({ code: CODE });
    c.setMeta({ title: "Persisted" });

    await vi.waitFor(() => {
      const rec = records.get(claimedLocalKey(CODE));
      expect(rec?.snapshot.title).toBe("Persisted");
    });
    // and nothing landed under the draft slot or any token-shaped key
    expect([...records.keys()]).toEqual([claimedLocalKey(CODE)]);
  });

  it("a refused open lands in the missing dead-end — not a draft, no create", async () => {
    // What a lapsed session or a revoked claim looks like from here: the same
    // bare 401 editAuth sends for both (editAuthGate.test.ts pins that side).
    refuseOpens = true;
    try {
      const c = useGearList();
      await c.load({ code: CODE });
      expect(c.status.value).toBe("missing");
      expect(c.openedByCode.value).toBe(true); // the dead-end can say WHY (see GearEditor)
      expect(createCalls).toBe(0);
      expect(useMyLists().entries.value).toHaveLength(0);
    } finally {
      refuseOpens = false;
    }
  });

  it("rotate graduates the open to the token path and re-keys everything", async () => {
    const c = useGearList();
    await c.load({ code: CODE });
    c.setMeta({ title: "Before rotate" });
    await flushed();

    const next = await c.rotate();
    expect(next).toBe(ROTATED_TOKEN);
    // the rotate itself went out on the code — the last act of the session path
    expect(rotateAuth[0]).toEqual({ bearer: undefined, listCode: CODE });
    expect(c.openedByCode.value).toBe(false);
    expect(c.editToken).toBe(ROTATED_TOKEN);

    // the device now holds the capability: a registry row exists…
    const rows = useMyLists().entries.value;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ editToken: ROTATED_TOKEN, shareCode: CODE });
    // …the code-keyed record is gone, and the copy re-keys onto the token
    await vi.waitFor(() => {
      expect(records.has(claimedLocalKey(CODE))).toBe(false);
      expect(records.has(ROTATED_TOKEN)).toBe(true);
    });

    // and the next edit no longer names the claim. (The Bearer half of the
    // hand-off can't be asserted here: test-utils' fetch mock delivers custom
    // headers but not Authorization — a probe confirmed even the plain token
    // path arrives bearer-less. authHeaders() is a two-line branch on editToken,
    // which the getter above already pins; the wire truth is covered live.)
    mutateAuth = [];
    c.setMeta({ title: "After rotate" });
    await vi.waitFor(() => expect(mutateAuth).toHaveLength(1));
    expect(mutateAuth[0]).toMatchObject({ listCode: undefined, ops: [{ t: "setMeta", patch: { title: "After rotate" } }] });
  });
});