// @vitest-environment nuxt
//
// Nesting: the wrap, the unwrap, and the reindex.
//
// These had NO tests. `nestItem` appeared in the suite only as a `() => {}` stub in
// three components' mock controllers, and `moveItem` — the reducer-facing move every
// drag, indent and outdent goes through — had none at all. That is a gap worth more
// than it looks: the wrap/unwrap pair is the subtlest logic in useGearList, its
// comments cite two real bugs it exists to fix (a product losing its label, and a
// stray childless row surviving discardEmpty), and both failures are silent — the
// list still renders, it just quietly says the wrong thing.
//
// Driven through the real controller for the same reason gearList.nuxt.test.ts is:
// the behavior under test is a SEQUENCE of dispatches against live snapshot state
// (wrap, then move, then clear a label, then maybe unwrap), and a helper extracted
// for testability would be exercising a different shape than the one that breaks.
// Assertions are on the resulting snapshot, which is what a row actually renders.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import type { Item, ListSnapshot } from "~~/shared/types";

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(false),
  vaultFetch: <T,>() => Promise.resolve({} as T),
}));

const records = new Map<string, unknown>();
mockNuxtImport("useLocalListStore", () => () => ({
  get: async () => undefined,
  set: async (key: string, record: unknown) => void records.set(key, record),
  del: async (key: string) => void records.delete(key),
}));

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
});

const TOKEN = "nesting-edit-token";
const FOLDER = "f1";

const item = (over: Partial<Item> & { id: string }): Item => ({
  folderId: FOLDER,
  parentId: null,
  name: "",
  unitWeightMg: 0,
  qty: 1,
  classification: null,
  sortOrder: 0,
  ...over,
});

let listResponse: ListSnapshot;
registerEndpoint("/api/edit/list", () => ({ snapshot: listResponse }));
registerEndpoint("/api/edit/changes", () => ({ version: 1 }));
registerEndpoint("/api/catalog/use", () => ({}));
// Swallow writes: these cases are about the optimistic snapshot the reducer builds,
// not about what reaches the server.
registerEndpoint("/api/edit/mutate", { method: "POST", handler: () => ({ ok: true }) });

function listWith(items: Item[], version = 1): ListSnapshot {
  return {
    shareCode: "NESTCODE0001",
    slug: "nesting-list-aaa",
    title: "Nesting",
    description: "",
    displayUnit: "g",
    folders: [{ id: FOLDER, name: "Shelter", colorKey: "green", defaultClassification: "base", sortOrder: 0 }],
    // the carrier cases below assign rows to Sam — he has to exist, or the
    // reducer's dangling-assignee heal quietly strips the very field under test
    people: [{ id: "sam", name: "Sam", sortOrder: 0 }],
    items,
    version,
    isPublic: false,
  };
}

/** This list's items, top-level first then children, in sortOrder. */
const itemsOf = (c: ReturnType<typeof useGearList>) =>
  [...(c.snapshot.value?.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
const byId = (c: ReturnType<typeof useGearList>, id: string) =>
  c.snapshot.value?.items.find((i) => i.id === id);
const childrenOf = (c: ReturnType<typeof useGearList>, parentId: string) =>
  itemsOf(c).filter((i) => i.parentId === parentId);

async function open(items: Item[]) {
  listResponse = listWith(items);
  const c = useGearList();
  await c.load({ token: TOKEN });
  return c;
}

describe("nesting into a row that carries a weight", () => {
  beforeEach(() => {
    records.clear();
    storage.clear();
  });
  afterEach(() => useGearList().dispose());

  // The wrap. A parent's weight column shows the GROUP total and is read-only, so
  // nesting under a row that has its own weight would take that weight into hiding:
  // counted in every total, printed on no row, editable in no field.
  it("wraps the product in a group rather than hiding its weight", async () => {
    const c = await open([
      item({ id: "tent", name: "X-Mid Pro 1", commonName: "Tent", unitWeightMg: 439418, sortOrder: 0 }),
      item({ id: "stakes", name: "Stakes", unitWeightMg: 50000, sortOrder: 1 }),
    ]);

    c.nestItem("stakes", "tent");
    await vi.waitFor(() => expect(byId(c, "stakes")?.parentId).not.toBeNull());

    const tent = byId(c, "tent")!;
    // the product is no longer top-level — it slid under a new container
    expect(tent.parentId).not.toBeNull();
    const group = byId(c, tent.parentId!)!;
    // the group takes the product's slot, and its GEAR TYPE as a name
    expect(group.name).toBe("Tent");
    expect(group.unitWeightMg).toBe(0);
    expect(group.parentId).toBeNull();
    // the product keeps its own weight — the whole point of wrapping
    expect(tent.unitWeightMg).toBe(439418);
    // and both rows are under the one group
    expect(childrenOf(c, group.id).map((i) => i.id).sort()).toEqual(["stakes", "tent"]);
  });

  // commonNameOverridden, not merely an empty commonName: the child keeps its catalog
  // link, and hydrateCatalogNames refills an un-overridden common name from the catalog
  // on the very next snapshot — the label would come straight back and print twice.
  it("takes the gear type off the child so it isn't printed on both lines", async () => {
    const c = await open([
      item({ id: "tent", name: "X-Mid Pro 1", commonName: "Tent", unitWeightMg: 439418, catalogItemId: 7, sortOrder: 0 }),
      item({ id: "stakes", name: "Stakes", unitWeightMg: 50000, sortOrder: 1 }),
    ]);

    c.nestItem("stakes", "tent");
    // The wrap dispatches `commonName: ""`, but the reducer's canonical empty is
    // `undefined` (cleanText(...) || undefined — shared/ops.ts), so assert the
    // CONTRACT (no label on the child) rather than which falsy value carries it.
    await vi.waitFor(() => expect(byId(c, "tent")?.commonName).toBeFalsy());
    // The flag is the load-bearing half: without it hydrateCatalogNames refills the
    // label from the catalog on the next snapshot and it prints on both lines again.
    expect(byId(c, "tent")?.commonNameOverridden).toBe(true);
  });

  // A row with no weight is already a container — this is what keeps a hand-built
  // "Cook kit" group working exactly as it did before wrapping existed.
  it("nests straight into a weightless row, wrapping nothing", async () => {
    const c = await open([
      item({ id: "cook", name: "Cook kit", unitWeightMg: 0, sortOrder: 0 }),
      item({ id: "pot", name: "Pot", unitWeightMg: 120000, sortOrder: 1 }),
    ]);
    const before = itemsOf(c).length;

    c.nestItem("pot", "cook");
    await vi.waitFor(() => expect(byId(c, "pot")?.parentId).toBe("cook"));
    // no group was minted
    expect(itemsOf(c)).toHaveLength(before);
  });

  // Whatever weight it had became a child's the first time round, so a second nest
  // must not wrap the wrapper.
  it("does not wrap a row that already holds children", async () => {
    const c = await open([
      item({ id: "grp", name: "Cook kit", unitWeightMg: 0, sortOrder: 0 }),
      item({ id: "pot", name: "Pot", parentId: "grp", unitWeightMg: 120000, sortOrder: 0 }),
      item({ id: "spoon", name: "Spoon", unitWeightMg: 15000, sortOrder: 1 }),
    ]);
    const before = itemsOf(c).length;

    c.nestItem("spoon", "grp");
    await vi.waitFor(() => expect(byId(c, "spoon")?.parentId).toBe("grp"));
    expect(itemsOf(c)).toHaveLength(before);
  });
});

describe("pulling the last child back out", () => {
  beforeEach(() => {
    records.clear();
    storage.clear();
  });
  afterEach(() => useGearList().dispose());

  // The reverse of the wrap, and the reason it exists: without it, nest-then-unnest
  // loses in BOTH directions — the product's gear type was cleared with
  // commonNameOverridden set (so live-resolve can't refill it), and the childless
  // container outlives discardEmpty precisely because it has a name. The user is left
  // with a product missing its label plus a stray zero-weight row.
  it("undoes the wrap: the name goes back and the container goes", async () => {
    const c = await open([
      item({ id: "tent", name: "X-Mid Pro 1", commonName: "Tent", unitWeightMg: 439418, sortOrder: 0 }),
      item({ id: "stakes", name: "Stakes", unitWeightMg: 50000, sortOrder: 1 }),
    ]);

    c.nestItem("stakes", "tent");
    await vi.waitFor(() => expect(byId(c, "tent")?.parentId).not.toBeNull());
    const groupId = byId(c, "tent")!.parentId!;

    // take both children back out — the second one empties the container
    c.unnest("stakes");
    await vi.waitFor(() => expect(byId(c, "stakes")?.parentId).toBeNull());
    c.unnest("tent");

    await vi.waitFor(() => expect(byId(c, groupId)).toBeUndefined());
    // the gear type came back to the product...
    expect(byId(c, "tent")?.commonName).toBe("Tent");
    // ...and the product is top-level again, with its weight intact
    expect(byId(c, "tent")?.parentId).toBeNull();
    expect(byId(c, "tent")?.unitWeightMg).toBe(439418);
  });

  // A hand-built group is shaped like a wrap group — a name and nothing else — so the
  // discriminator is on the CHILD, not the container. A group the user named and filled
  // must survive its last child leaving.
  it("keeps a group the user built themselves", async () => {
    const c = await open([
      item({ id: "cook", name: "Cook kit", unitWeightMg: 0, sortOrder: 0 }),
      item({ id: "pot", name: "Pot", parentId: "cook", unitWeightMg: 120000, sortOrder: 0 }),
    ]);

    c.unnest("pot");
    await vi.waitFor(() => expect(byId(c, "pot")?.parentId).toBeNull());
    // the container the user typed a name into is still there
    expect(byId(c, "cook")?.name).toBe("Cook kit");
  });

  // Outdent drops the row right after its former parent, so it lands where the eye
  // expects rather than at the end of the folder.
  it("drops an outdented row directly after the parent it left", async () => {
    const c = await open([
      item({ id: "grp", name: "Cook kit", unitWeightMg: 0, sortOrder: 0 }),
      item({ id: "pot", name: "Pot", parentId: "grp", unitWeightMg: 120000, sortOrder: 0 }),
      item({ id: "tail", name: "Tail", unitWeightMg: 1000, sortOrder: 1 }),
    ]);

    c.unnest("pot");
    await vi.waitFor(() => expect(byId(c, "pot")?.parentId).toBeNull());

    const top = itemsOf(c).filter((i) => i.parentId == null);
    expect(top.map((i) => i.id)).toEqual(["grp", "pot", "tail"]);
  });
});

describe("moveItem's reindex", () => {
  beforeEach(() => {
    records.clear();
    storage.clear();
  });
  afterEach(() => useGearList().dispose());

  // Reindexed to clean 0..n-1 integers in the new order: collision-proof and
  // self-healing against duplicate sortOrders, which would otherwise re-sort
  // ambiguously on the next reload.
  it("renumbers the container to 0..n-1 after a reorder", async () => {
    const c = await open([
      item({ id: "a", name: "A", unitWeightMg: 1, sortOrder: 0 }),
      item({ id: "b", name: "B", unitWeightMg: 2, sortOrder: 5 }),
      item({ id: "c", name: "C", unitWeightMg: 3, sortOrder: 9 }),
    ]);

    // move C to the front
    c.moveItem("c", FOLDER, "a");
    await vi.waitFor(() => expect(byId(c, "c")?.sortOrder).toBe(0));

    const top = itemsOf(c).filter((i) => i.parentId == null);
    expect(top.map((i) => i.id)).toEqual(["c", "a", "b"]);
    expect(top.map((i) => i.sortOrder)).toEqual([0, 1, 2]);
  });

  it("appends when there is nothing to land before", async () => {
    const c = await open([
      item({ id: "a", name: "A", unitWeightMg: 1, sortOrder: 0 }),
      item({ id: "b", name: "B", unitWeightMg: 2, sortOrder: 1 }),
    ]);

    c.moveItem("a", FOLDER, null);
    await vi.waitFor(() => expect(byId(c, "a")?.sortOrder).toBe(1));
    expect(itemsOf(c).filter((i) => i.parentId == null).map((i) => i.id)).toEqual(["b", "a"]);
  });
});

describe("the carrier through a wrap and its unwrap", () => {
  it("wrapping a weighted row keeps its carrier on the new group", async () => {
    // nesting into a row with a weight wraps it — and the group takes the
    // product's SLOT, so it must take the product's carrier with it, or every
    // later child inherits nobody (and, under a person filter, "add a nested
    // item" builds a row the CSS immediately hides)
    const c = await open([
      item({ id: "tent", name: "Tent", unitWeightMg: 900_000, personId: "sam", sortOrder: 0 }),
      item({ id: "stakes", name: "Stakes", sortOrder: 1 }),
    ]);

    c.nestItem("stakes", "tent");
    await vi.waitFor(() => expect(byId(c, "tent")?.parentId).not.toBeNull());
    const groupId = byId(c, "tent")!.parentId!;
    expect(byId(c, groupId)?.personId).toBe("sam"); // the group stands where the product stood
    expect(byId(c, "tent")?.personId).toBe("sam"); // and the product keeps its own claim
    expect(byId(c, "stakes")?.parentId).toBe(groupId);
  });

  it("unwrapping hands a container's claim down to the child that was inheriting it", async () => {
    // the wrap's signature state, with the GROUP assigned and the child riding on
    // inheritance — deleting the container must not silently unclaim the row
    const c = await open([
      item({ id: "g", name: "Tent", personId: "sam", sortOrder: 0 }),
      item({ id: "body", name: "Tent body", parentId: "g", unitWeightMg: 900_000, commonNameOverridden: true, sortOrder: 0 }),
    ]);

    c.unnest("body");
    await vi.waitFor(() => expect(byId(c, "body")?.parentId).toBeNull());
    expect(byId(c, "g")).toBeUndefined(); // the wrapper unwound
    expect(byId(c, "body")?.personId).toBe("sam"); // the claim moved down with the name
    expect(byId(c, "body")?.commonName).toBe("Tent");
  });
});
