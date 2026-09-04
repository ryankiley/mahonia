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
  vaultKnown: ref(true), // answered, and answered "signed out" — see gearList.nuxt
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
    // defaultClassification null: not in Classification, but weights.ts falls back to
    // "base" for exactly this — see the note in gearList.nuxt.test.ts.
    folders: [{ id: FOLDER, name: "Shelter", colorKey: "green", defaultClassification: null as never, sortOrder: 0 }],
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

  // On a group, entryUnit is the unit its TOTAL is shown in (ItemRow's rowUnit), so
  // the wrap has to hand it over with the slot: a row reading "15.5 oz" that becomes
  // a group of one must still read in ounces, or nesting silently re-expressed a
  // number the gesture never touched.
  it("carries the product's unit up to the group it minted", async () => {
    const c = await open([
      item({ id: "tent", name: "X-Mid Pro 1", commonName: "Tent", unitWeightMg: 439418, entryUnit: "oz", sortOrder: 0 }),
      item({ id: "stakes", name: "Stakes", unitWeightMg: 50000, sortOrder: 1 }),
    ]);

    c.nestItem("stakes", "tent");
    await vi.waitFor(() => expect(byId(c, "stakes")?.parentId).not.toBeNull());

    const group = byId(c, byId(c, "tent")!.parentId!)!;
    expect(group.entryUnit).toBe("oz");
    // and the product keeps its own — it is still a row that was typed in ounces
    expect(byId(c, "tent")?.entryUnit).toBe("oz");
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

// Duplicating a row — the whole row, not just its name.
//
// The bug this answers isn't a bug: it's arithmetic. A row costs a name plus every
// other decision on it (mark it consumable, give it calories, weigh it, assign a
// carrier), and a trip eating the same food on eight days paid all of them eight
// times. The copy already knows every one of those answers.
describe("duplicating a row", () => {
  beforeEach(() => {
    records.clear();
    storage.clear();
  });
  afterEach(() => useGearList().dispose());

  it("carries every field over and lands directly below the source", async () => {
    const c = await open([
      item({
        id: "pretzels",
        name: "Sourdough pretzels",
        // apostrophe-free on purpose: the copy passes through normalizeItem, which
        // tidies a straight apostrophe to a curly one (a real behaviour, and not this
        // test's) — the source came off the loaded snapshot and never met it
        brand: "Unique Snacks",
        variant: "8 oz",
        commonName: "Snack",
        commonNameOverridden: true,
        nameOverridden: true,
        unitWeightMg: 227_000,
        weightOverridden: true,
        entryUnit: "oz",
        qty: 2,
        classification: "consumable",
        kcal: 310,
        description: "day three",
        productUrl: "https://example.com/pretzels",
        personId: "sam",
        sortOrder: 0,
      }),
      item({ id: "after", name: "After", sortOrder: 1 }),
    ]);

    const newId = c.duplicateItem("pretzels");
    await vi.waitFor(() => expect(byId(c, newId)).toBeTruthy());

    // every field but the row's identity and its place — the three the copy has to
    // mint for itself. This is asserted as one comparison rather than field by field
    // on purpose: a field-by-field list would keep passing when the Item type grows
    // a field the copy silently stops carrying.
    // packed is excluded here and asserted on its own below — it is the one field a
    // copy deliberately does NOT inherit
    const { id: _si, sortOrder: _ss, packed: _sp, ...src } = byId(c, "pretzels")!;
    const { id: _ci, sortOrder: _cs, packed: _cp, ...copy } = byId(c, newId)!;
    // on the DEFINED keys: the copy goes through normalizeItem (the source came
    // straight off the loaded snapshot and didn't), and the normalizer writes some
    // optionals as an explicit `undefined` — which every reader treats as absent
    const defined = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
    expect(defined(copy)).toEqual(defined(src));

    // "Duplicate" means below THIS row, not at the end of the folder — the copy
    // should land where the eye already is
    expect(itemsOf(c).map((i) => i.id)).toEqual(["pretzels", newId, "after"]);
    expect(itemsOf(c).map((i) => i.sortOrder)).toEqual([0, 1, 2]);
  });

  it("arrives unpacked, whatever the source was", async () => {
    const c = await open([item({ id: "bar", name: "Bar", packed: true, sortOrder: 0 })]);

    const newId = c.duplicateItem("bar");
    await vi.waitFor(() => expect(byId(c, newId)).toBeTruthy());

    // packed records a checklist tick from the night before a trip — a fact about
    // that evening, not about the gear
    expect(byId(c, "bar")?.packed).toBe(true);
    expect(byId(c, newId)?.packed).toBe(false); // normalizeItem's `!!raw.packed`
  });

  it("brings a group's children with it, on fresh ids", async () => {
    const c = await open([
      item({ id: "tent", name: "Tent", sortOrder: 0 }),
      item({ id: "fly", name: "Fly", parentId: "tent", unitWeightMg: 300_000, sortOrder: 0 }),
      item({ id: "poles", name: "Poles", parentId: "tent", unitWeightMg: 400_000, sortOrder: 1 }),
    ]);

    const newId = c.duplicateItem("tent");
    await vi.waitFor(() => expect(childrenOf(c, newId).length).toBe(2));

    // a group IS its children — a copy without them weighs nothing and means nothing
    const kids = childrenOf(c, newId);
    expect(kids.map((i) => i.name)).toEqual(["Fly", "Poles"]);
    expect(kids.map((i) => i.unitWeightMg)).toEqual([300_000, 400_000]);
    // fresh ids: the originals stay put under the original group
    expect(kids.map((i) => i.id)).not.toContain("fly");
    expect(kids.map((i) => i.id)).not.toContain("poles");
    expect(childrenOf(c, "tent").map((i) => i.id)).toEqual(["fly", "poles"]);
  });

  it("drops a copy into the slot a drag resolved", async () => {
    // the Alt-drag path: the same resolved target a move would have committed to
    const c = await open([
      item({ id: "bar", name: "Bar", classification: "consumable", kcal: 250, sortOrder: 0 }),
      item({ id: "x", name: "X", folderId: null, sortOrder: 0 }),
      item({ id: "y", name: "Y", folderId: null, sortOrder: 1 }),
    ]);

    const newId = c.duplicateItem("bar", { folderId: null, beforeId: "y", parentId: null });
    await vi.waitFor(() => expect(byId(c, newId)).toBeTruthy());

    // the source is still where it was — that is the whole difference from a move
    expect(byId(c, "bar")?.folderId).toBe(FOLDER);
    const ungrouped = itemsOf(c).filter((i) => i.folderId === null);
    expect(ungrouped.map((i) => i.id)).toEqual(["x", newId, "y"]);
    expect(ungrouped.map((i) => i.sortOrder)).toEqual([0, 1, 2]);
    // and the copy took the calories with it, which is the point of the gesture
    expect(byId(c, newId)?.kcal).toBe(250);
    expect(byId(c, newId)?.classification).toBe("consumable");
  });

  it("keeps a nested row's copy under the same parent", async () => {
    const c = await open([
      item({ id: "kit", name: "Cook kit", sortOrder: 0 }),
      item({ id: "pot", name: "Pot", parentId: "kit", unitWeightMg: 100_000, sortOrder: 0 }),
      item({ id: "spoon", name: "Spoon", parentId: "kit", unitWeightMg: 10_000, sortOrder: 1 }),
    ]);

    const newId = c.duplicateItem("pot");
    await vi.waitFor(() => expect(childrenOf(c, "kit").length).toBe(3));

    // below the row it copied, inside the group it copied from
    expect(childrenOf(c, "kit").map((i) => i.id)).toEqual(["pot", newId, "spoon"]);
    expect(byId(c, newId)?.parentId).toBe("kit");
    expect(byId(c, newId)?.folderId).toBe(FOLDER);
  });

  it("appends the copy when the source is the last row", async () => {
    const c = await open([
      item({ id: "a", name: "A", sortOrder: 0 }),
      item({ id: "b", name: "B", sortOrder: 1 }),
    ]);

    const newId = c.duplicateItem("b");
    await vi.waitFor(() => expect(byId(c, newId)).toBeTruthy());
    expect(itemsOf(c).map((i) => i.id)).toEqual(["a", "b", newId]);
  });

  it("does nothing for a row that isn't there", async () => {
    const c = await open([item({ id: "a", name: "A", sortOrder: 0 })]);
    expect(c.duplicateItem("ghost")).toBe("");
    expect(itemsOf(c)).toHaveLength(1);
  });
});
