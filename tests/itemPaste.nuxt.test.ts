// @vitest-environment nuxt
//
// A list pasted into an item's name, one item per line.
//
// The pure half — what a line becomes — is checked as plain TS in pasteList.test.ts.
// This file is for the part that only exists once things are wired together: the
// paste event landing on the real <ItemRow>'s name field, the first line committing
// through the row's own onNameCommit, the rest reaching the real controller's
// pasteItemsAfter, and the rows it makes — placed, weighed, linked to the catalog by
// the same endpoint the importer asks — read back from the snapshot the row renders.
// Driven end to end for the reason itemNesting.nuxt is: the behavior is a sequence of
// dispatches against live state, and a helper extracted for testability would be a
// different shape than the one that breaks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage } from "./helpers/storage";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { readBody } from "h3";
import { flushPromises, mount } from "@vue/test-utils";
import ItemRow from "~/components/ItemRow.vue";
import { rowProvides } from "./helpers/itemRow";
import { MAX_ITEMS } from "~~/shared/ops";
import type { Item, ListSnapshot } from "~~/shared/types";
import type { CatalogSearchResult } from "~~/shared/catalogSearch";

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(false),
  vaultKnown: ref(true),
  vaultFetch: <T,>() => Promise.resolve({} as T),
}));

const records = new Map<string, unknown>();
mockNuxtImport("useLocalListStore", () => () => ({
  get: async () => undefined,
  set: async (key: string, record: unknown) => void records.set(key, record),
  del: async (key: string) => void records.delete(key),
}));

const storage = stubLocalStorage();

const TOKEN = "paste-edit-token";
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
registerEndpoint("/api/catalog/search", () => ({ results: [] }));
registerEndpoint("/api/edit/mutate", { method: "POST", handler: () => ({ ok: true }) });

// What the catalog knows, word for word — the endpoint answers positionally, a row or
// null per name, exactly as the real one does. `matchAsked` records what it was asked.
const catalog = new Map<string, CatalogSearchResult>();
let matchAsked: string[][] = [];
registerEndpoint("/api/catalog/match", {
  method: "POST",
  handler: async (event) => {
    const body = await readBody<{ names: { name: string }[] }>(event);
    const names = body.names.map((n) => n.name);
    matchAsked.push(names);
    return { matches: names.map((n) => catalog.get(n) ?? null) };
  },
});

const LANSHAN: CatalogSearchResult = {
  id: 1,
  brand: "3FULGEAR",
  name: "Lanshan 1 Pro Tent",
  variant: null,
  commonName: "Tent",
  weightMg: 688_000,
  verified: true,
  categoryHint: "shelter",
} as CatalogSearchResult;

const BAR: CatalogSearchResult = {
  id: 2,
  brand: "Clif",
  name: "Bar",
  variant: null,
  commonName: "Snack",
  weightMg: 68_000,
  kcal: 250,
  verified: true,
  categoryHint: "consumable",
} as CatalogSearchResult;

function listWith(items: Item[], displayUnit: "g" | "oz" = "g"): ListSnapshot {
  return {
    shareCode: "PASTECODE001",
    slug: "paste-list-aaa",
    title: "Paste",
    description: "",
    displayUnit,
    folders: [{ id: FOLDER, name: "Shelter", colorKey: "green", defaultClassification: "base", sortOrder: 0 }],
    items,
    version: 1,
    isPublic: false,
  };
}

const itemsOf = (c: ReturnType<typeof useGearList>) =>
  [...(c.snapshot.value?.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
const byId = (c: ReturnType<typeof useGearList>, id: string) => c.snapshot.value?.items.find((i) => i.id === id);

async function open(items: Item[], displayUnit: "g" | "oz" = "g") {
  listResponse = listWith(items, displayUnit);
  const c = useGearList();
  await c.load({ token: TOKEN });
  return c;
}

/** The real row, mounted over the live controller's snapshot — a commit re-renders it. */
function mountRow(c: ReturnType<typeof useGearList>, id: string) {
  return mount(ItemRow, {
    props: {
      get list() {
        return c.snapshot.value!;
      },
      get item() {
        return c.snapshot.value!.items.find((i) => i.id === id)!;
      },
    },
    global: { provide: rowProvides() },
    attachTo: document.body,
  });
}

/** Paste into the row's name field the way the browser delivers it: a cancelable
 *  event carrying the clipboard's text. Returns whether the field took it over. */
function pasteInto(w: ReturnType<typeof mountRow>, text: string, select?: [number, number]): boolean {
  const input = w.find<HTMLInputElement>('input[aria-label="Name of item"]').element;
  input.focus();
  if (select) input.setSelectionRange(select[0], select[1]);
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: { getData: () => text } });
  input.dispatchEvent(ev);
  return ev.defaultPrevented;
}

beforeEach(() => {
  records.clear();
  storage.clear();
  catalog.clear();
  matchAsked = [];
});
afterEach(() => useGearList().dispose());

describe("pasting a list into an item's name", () => {
  it("makes one row per line, after the row pasted into, first line included", async () => {
    const c = await open([
      item({ id: "tent", name: "Tent", sortOrder: 0 }),
      item({ id: "blank", sortOrder: 1 }),
      item({ id: "pad", name: "Pad", sortOrder: 2 }),
    ]);
    const w = mountRow(c, "blank");

    expect(pasteInto(w, "Quilt 540 g\n- Stove - 85 g\n\n  \nPot\nwater\n")).toBe(true);
    await flushPromises();

    // the row you pasted into is the list's first row: named, weighed, its unit noted
    const quilt = byId(c, "blank")!;
    expect(quilt.name).toBe("Quilt");
    expect(quilt.unitWeightMg).toBe(540_000);
    expect(quilt.weightOverridden).toBe(true);
    expect(quilt.entryUnit).toBe("g");
    // the rest follow it, in order, ahead of what came after it
    expect(itemsOf(c).map((i) => i.name)).toEqual(["Tent", "Quilt", "Stove", "Pot", "water", "Pad"]);
    const stove = itemsOf(c)[2]!;
    expect(stove.unitWeightMg).toBe(85_000);
    expect(stove.weightOverridden).toBe(true);
    expect(stove.nameOverridden).toBe(true);
    expect(stove.folderId).toBe(FOLDER);
    expect(itemsOf(c)[3]).toMatchObject({ name: "Pot", unitWeightMg: 0 });
    // a line that just says water is the water row, consumable — the field's own rule
    expect(itemsOf(c)[4]).toMatchObject({ name: "water", classification: "consumable" });
    // and the field itself shows the first line, not the whole paste
    expect(w.find<HTMLInputElement>('input[aria-label="Name of item"]').element.value).toBe("Quilt");

    // the count, said through the undo toast
    expect(c.pendingUndo.value).toMatchObject({ verb: "Added", label: "3 rows" });
    w.unmount();
  });

  it("undo takes the rows away and leaves the one you pasted into", async () => {
    const c = await open([item({ id: "blank", sortOrder: 0 }), item({ id: "pad", name: "Pad", sortOrder: 1 })]);
    const w = mountRow(c, "blank");
    pasteInto(w, "Quilt\nStove\nPot");
    await flushPromises();
    expect(itemsOf(c).map((i) => i.name)).toEqual(["Quilt", "Stove", "Pot", "Pad"]);

    c.undoRemove();
    expect(itemsOf(c).map((i) => i.name)).toEqual(["Quilt", "Pad"]);
    expect(c.pendingUndo.value).toBeNull();
    w.unmount();
  });

  it("leaves a single line to the browser's own paste", async () => {
    const c = await open([item({ id: "blank", sortOrder: 0 })]);
    const w = mountRow(c, "blank");

    expect(pasteInto(w, "Quilt")).toBe(false);
    await flushPromises();
    expect(itemsOf(c)).toHaveLength(1);
    expect(matchAsked).toEqual([]);
    w.unmount();
  });

  it("links a line that names a catalog product, the way a pick would", async () => {
    catalog.set("Lanshan 1 Pro Tent", LANSHAN);
    catalog.set("Bar", BAR);
    const c = await open([item({ id: "blank", sortOrder: 0 })]);
    const w = mountRow(c, "blank");

    // the first line too: it went into the row pasted into through the plain
    // free-text commit, which links nothing on its own
    pasteInto(w, "Lanshan 1 Pro Tent\nBar 70 g\nPot");
    await flushPromises();
    await vi.waitFor(() => expect(byId(c, "blank")?.catalogItemId).toBe(1));

    // one request, every row named, the pasted-into row first
    expect(matchAsked).toEqual([["Lanshan 1 Pro Tent", "Bar", "Pot"]]);
    // no weight on the line: the catalog's, as the link baseline
    const tent = byId(c, "blank")!;
    expect(tent).toMatchObject({
      brand: "3FULGEAR",
      name: "Lanshan 1 Pro Tent",
      commonName: "Tent",
      unitWeightMg: 688_000,
      weightOverridden: false,
      nameOverridden: false,
      catalogItemId: 1,
      catalogWeightMgAtLink: 688_000,
    });
    expect(tent.classification).toBeNull(); // a shelter stays on the folder's default
    // a weight on the line stands, marked as disagreeing with the catalog; food
    // arrives consumable with its calories
    const bar = itemsOf(c)[1]!;
    expect(bar).toMatchObject({
      brand: "Clif",
      unitWeightMg: 70_000,
      weightOverridden: true,
      catalogItemId: 2,
      catalogWeightMgAtLink: 68_000,
      classification: "consumable",
      kcal: 250,
    });
    // an unknown name is left as typed
    expect(itemsOf(c)[2]).toMatchObject({ name: "Pot", nameOverridden: true });
    expect(itemsOf(c)[2]!.catalogItemId).toBeUndefined();
    w.unmount();
  });

  // The first line lands where the caret is, replacing what's selected — the paste's
  // own rule for the field you're in. Select-all then paste over a linked row is a
  // rename, and the row follows the new name: the free-text commit drops the old
  // link as typing would, then the catalog answers for what the row now says.
  it("replaces a selected name with the first line, and re-links to what it now says", async () => {
    catalog.set("Lanshan 1 Pro Tent", LANSHAN);
    const c = await open([
      item({ id: "linked", name: "Duplex", brand: "Zpacks", catalogItemId: 200, unitWeightMg: 545_000, sortOrder: 0 }),
    ]);
    const w = mountRow(c, "linked");

    pasteInto(w, "Lanshan 1 Pro Tent\nPot", [0, "Zpacks Duplex".length]);
    await flushPromises();
    await vi.waitFor(() => expect(byId(c, "linked")?.catalogItemId).toBe(1));

    expect(matchAsked).toEqual([["Lanshan 1 Pro Tent", "Pot"]]);
    // the row's weight stands, as the importer's rule has it (a weight on a row is
    // never overwritten), marked as disagreeing so the catalog's figure is offered
    expect(byId(c, "linked")).toMatchObject({
      brand: "3FULGEAR",
      name: "Lanshan 1 Pro Tent",
      unitWeightMg: 545_000,
      weightOverridden: true,
      catalogWeightMgAtLink: 688_000,
    });
    w.unmount();
  });

  // lines arrive trimmed, so this reads as one word — the case is about WHERE the
  // first line lands, which is the caret, not the start or the end of the field
  it("inserts the first line at the caret when nothing is selected", async () => {
    const c = await open([item({ id: "row", name: "Bigtent", sortOrder: 0 })]);
    const w = mountRow(c, "row");

    pasteInto(w, "Agnes\nPot", [3, 3]);
    await flushPromises();

    expect(itemsOf(c).map((i) => i.name)).toEqual(["BigAgnestent", "Pot"]);
    w.unmount();
  });

  it("does not link a row retyped before the catalog answered", async () => {
    catalog.set("Lanshan 1 Pro Tent", LANSHAN);
    const c = await open([item({ id: "blank", sortOrder: 0 })]);
    const w = mountRow(c, "blank");

    pasteInto(w, "Quilt\nLanshan 1 Pro Tent");
    // before the answer lands, the row is renamed by hand
    const pasted = itemsOf(c)[1]!;
    c.updateItem(pasted.id, { name: "My old tarp" });
    await flushPromises();
    await vi.waitFor(() => expect(matchAsked).toHaveLength(1));
    await flushPromises();

    expect(byId(c, pasted.id)).toMatchObject({ name: "My old tarp" });
    expect(byId(c, pasted.id)!.catalogItemId).toBeUndefined();
    w.unmount();
  });

  it("makes siblings under the same parent when pasted into a nested row", async () => {
    const c = await open([
      item({ id: "kit", name: "Cook kit", sortOrder: 0 }),
      item({ id: "pot", name: "Pot", parentId: "kit", sortOrder: 0 }),
      item({ id: "blank", parentId: "kit", sortOrder: 1 }),
      item({ id: "pad", name: "Pad", sortOrder: 1 }),
    ]);
    const w = mountRow(c, "blank");

    pasteInto(w, "Spoon\nLighter\nCup");
    await flushPromises();

    const kids = itemsOf(c).filter((i) => i.parentId === "kit");
    expect(kids.map((i) => i.name)).toEqual(["Pot", "Spoon", "Lighter", "Cup"]);
    expect(itemsOf(c).filter((i) => !i.parentId).map((i) => i.name)).toEqual(["Cook kit", "Pad"]);
    w.unmount();
  });

  it("stops at the list's cap and says how many it made", async () => {
    const full = Array.from({ length: MAX_ITEMS - 3 }, (_, i) => item({ id: `i${i}`, name: `Item ${i}`, sortOrder: i }));
    const c = await open([...full, item({ id: "blank", sortOrder: MAX_ITEMS })]);
    const w = mountRow(c, "blank");

    pasteInto(w, "One\nTwo\nThree\nFour\nFive");
    await flushPromises();

    expect(byId(c, "blank")!.name).toBe("One");
    expect(itemsOf(c)).toHaveLength(MAX_ITEMS);
    expect(itemsOf(c).slice(-3).map((i) => i.name)).toEqual(["One", "Two", "Three"]);
    expect(c.pendingUndo.value?.label).toBe(`2 of 4 rows (a list holds ${MAX_ITEMS} items)`);
    w.unmount();
  });
});
