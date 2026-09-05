// @vitest-environment nuxt
//
// Renaming a row THROUGH the autocomplete — the "this is actually a different piece
// of gear" edit. Drives the real <ItemRow>: the commit goes through the row's own
// onNameCommit, the patch is applied by the real reducer, and the assertions read the
// rendered row back.
//
// Why this needs the Nuxt environment (see vitest.config.ts — most suites shouldn't):
// the decision under test isn't one a pure function makes. onNameCommit builds a
// DIFFERENT patch for each of three provenances (catalog hit / your vault / free
// text), and the symptom is what the row then RENDERS — a weight field and a "suggest
// a fix" nudge whose condition spans four fields. The reducer half is checked as plain
// TS in ops.test.ts; this file exists for the half that only exists once the component
// is mounted.
//
// The four cases below are the matrix that matters: a row that arrived from the
// catalog and one that arrived from the vault, each renamed to a catalog hit and to a
// vault hit. The vault legs are where the bug lived — a vault pick can't stamp a
// catalog baseline, so before the reducer's guard the PREVIOUS product's spec weight
// stayed behind and the row offered to "fix" the new item's catalog entry with it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { flushPromises, mount } from "@vue/test-utils";
import ItemRow, { CHILDREN_BY_PARENT, PEOPLE_CTX } from "~/components/ItemRow.vue";
import ItemInput from "~/components/ItemInput.vue";
import type { Item, ListSnapshot, Person } from "~~/shared/types";
import { blankList } from "./helpers/list";
import { gearListStub } from "./helpers/gearList";
import type { NameCommit } from "~/composables/useCatalogSearch";

// what GearEditor provides to every row — the children map, and the people in
// display order with their slots (this list names nobody)
const rowProvides = {
  [CHILDREN_BY_PARENT as symbol]: ref(new Map<string, Item[]>()),
  [PEOPLE_CTX as symbol]: { sorted: ref<Person[]>([]), slotById: ref(new Map<string, number>()) },
};

// What the two halves of the autocomplete menu answer with, per case.
const catalogHits: Record<string, unknown>[] = [];
const vaultHits: Record<string, unknown>[] = [];
registerEndpoint("/api/catalog/search", () => ({ results: catalogHits }));
registerEndpoint("/api/catalog/use", { method: "POST", handler: () => ({ ok: true }) });

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  vaultKnown: ref(true),
  vaultFetch: () => Promise.resolve({ results: vaultHits }),
}));

// The list under test, as the editor holds it — a reactive snapshot the stub
// controller mutates through the REAL reducer, so what the row re-renders from is
// the state the app would actually have.
const snapshot = ref<ListSnapshot>(blankList());
mockNuxtImport("useGearList", () => () => gearListStub({ snapshot }));

// A row as a catalog pick leaves it: linked, the catalog's weight, and the link
// baseline stamped at the weight it was linked AT.
const catalogPicked: Item = {
  id: "i1",
  folderId: "f1",
  name: "Lanshan 1 Pro Tent",
  brand: "3FULGEAR",
  unitWeightMg: 688_000,
  weightOverridden: false,
  catalogItemId: 1,
  catalogWeightMgAtLink: 688_000,
  qty: 1,
  classification: null,
  sortOrder: 0,
};

// A row as a VAULT pick leaves it: your weight, your name, and a catalog link kept
// for provenance — but no link baseline, because your weight isn't the catalog's.
const vaultPicked: Item = {
  id: "i1",
  folderId: "f1",
  name: "Duplex",
  brand: "Zpacks",
  unitWeightMg: 545_000,
  weightOverridden: true,
  nameOverridden: true,
  catalogItemId: 200,
  qty: 1,
  classification: null,
  sortOrder: 0,
};

function mountRow(item: Item) {
  snapshot.value = { ...blankList(), items: [{ ...item }] } as ListSnapshot;
  return mount(ItemRow, {
    props: {
      // read off the reactive snapshot so a commit re-renders the row
      get list() {
        return snapshot.value;
      },
      get item() {
        return snapshot.value.items[0]!;
      },
    },
    global: { provide: rowProvides },
    attachTo: document.body,
  });
}

const row = () => snapshot.value.items[0]!;

async function rename(wrapper: ReturnType<typeof mountRow>, commit: NameCommit) {
  wrapper.findComponent(ItemInput).vm.$emit("commit", commit);
  await nextTick();
}

// what ItemInput.selectResult emits for a catalog hit
const fromCatalog = (over: Partial<NameCommit> = {}): NameCommit => ({
  name: "UltaMid Pyramid Tent",
  brand: "Hyperlite Mountain Gear",
  variant: "2 Person",
  weightMg: 541_000,
  catalogItemId: 76,
  ...over,
});

// what ItemInput.selectVault emits for a hit in your own gear
const fromVault = (over: Partial<NameCommit> = {}): NameCommit => ({
  name: "Duplex",
  brand: "Zpacks",
  weightMg: 545_000,
  catalogItemId: 200,
  fromVault: true,
  ...over,
});

describe("renaming a row to a different piece of gear", () => {
  beforeEach(() => {
    snapshot.value = blankList();
  });

  it("catalog row → another catalog row: takes the new weight", async () => {
    const w = mountRow(catalogPicked);
    await rename(w, fromCatalog());
    expect(row().unitWeightMg).toBe(541_000);
    expect(row().catalogItemId).toBe(76);
    expect(row().catalogWeightMgAtLink).toBe(541_000);
    expect(w.find(".item__fixrow").exists()).toBe(false);
    w.unmount();
  });

  it("catalog row → a vault row: takes your weight, no stale catalog baseline", async () => {
    const w = mountRow(catalogPicked);
    await rename(w, fromVault());
    expect(row().unitWeightMg).toBe(545_000);
    expect(row().catalogItemId).toBe(200);
    // the OLD product's catalog weight must not survive the re-link
    expect(row().catalogWeightMgAtLink).toBeUndefined();
    expect(w.find(".item__fixrow").exists()).toBe(false);
    w.unmount();
  });

  it("vault row → a catalog row: takes the catalog weight", async () => {
    const w = mountRow(vaultPicked);
    await rename(w, fromCatalog());
    expect(row().unitWeightMg).toBe(541_000);
    expect(row().catalogWeightMgAtLink).toBe(541_000);
    expect(w.find(".item__fixrow").exists()).toBe(false);
    w.unmount();
  });

  it("vault row → another vault row: takes the new weight", async () => {
    const w = mountRow(vaultPicked);
    await rename(w, fromVault({ name: "Plexamid", weightMg: 439_000, catalogItemId: 201 }));
    expect(row().unitWeightMg).toBe(439_000);
    expect(row().catalogItemId).toBe(201);
    expect(row().catalogWeightMgAtLink).toBeUndefined();
    expect(w.find(".item__fixrow").exists()).toBe(false);
    w.unmount();
  });

  it("the weight FIELD shows the new weight", async () => {
    const w = mountRow(catalogPicked);
    expect((w.find('input[aria-label="Weight"]').element as HTMLInputElement).value).toBe("688");
    await rename(w, fromCatalog());
    expect((w.find('input[aria-label="Weight"]').element as HTMLInputElement).value).toBe("541");
    w.unmount();
  });

  it("the weight FIELD shows the new weight after a vault rename", async () => {
    const w = mountRow(catalogPicked);
    await rename(w, fromVault());
    expect((w.find('input[aria-label="Weight"]').element as HTMLInputElement).value).toBe("545");
    w.unmount();
  });

  it("a vault pick brings back the calories the vault remembers", async () => {
    const w = mountRow(catalogPicked);
    await rename(w, fromVault({ name: "Trail Mix", classification: "consumable", kcal: 640 }));
    expect(row().classification).toBe("consumable");
    expect(row().kcal).toBe(640);
    w.unmount();
  });

  it("a vault pick with no calories leaves the row's own alone", async () => {
    const w = mountRow({ ...catalogPicked, classification: "consumable", kcal: 250 });
    await rename(w, fromVault({ name: "Trail Mix", classification: "consumable" }));
    expect(row().kcal).toBe(250);
    w.unmount();
  });
});

// The same rename driven through the REAL input — typing, waiting out the debounce,
// picking off the menu, then letting focus leave the field. The pick and the
// focus-out commit that follows it are two separate trips through onNameCommit, and
// only this route exercises the second one.
describe("renaming through the live autocomplete", () => {
  beforeEach(() => {
    snapshot.value = blankList();
    catalogHits.length = 0;
    vaultHits.length = 0;
  });

  async function typeAndPick(w: ReturnType<typeof mountRow>, text: string) {
    const field = w.find<HTMLInputElement>('input[role="combobox"]');
    await field.trigger("focus");
    field.element.value = text;
    await field.trigger("input");
    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();
    const opts = w.findAll(".ac__opt");
    expect(opts.length).toBeGreaterThan(0);
    await opts[0]!.trigger("mousedown");
    await nextTick();
  }

  // focus leaving the whole control — what happens the moment you click anywhere
  // else on the page after picking
  async function leaveField(w: ReturnType<typeof mountRow>) {
    await w.find(".ac").trigger("focusout", { relatedTarget: document.body });
    await nextTick();
  }

  // The one catalog hit and the one vault hit these cases rename TO — same product
  // in both halves of the menu, so the only thing that varies across the four
  // combinations is which side the row was picked from.
  const catalogHit = {
    id: 76,
    brand: "Hyperlite Mountain Gear",
    name: "UltaMid Pyramid Tent",
    variant: "2 Person",
    weightMg: 541_000,
    verified: true,
  };
  const vaultHit = {
    id: 9,
    normKey: "zpacks duplex",
    brand: "Zpacks",
    name: "Duplex",
    weightMg: 545_000,
    catalogItemId: 200,
    timesSeen: 1,
  };

  // Both directions, both sources: a row that arrived from the catalog and one that
  // arrived from the vault, each renamed to a catalog hit and to a vault hit.
  const cases = [
    { from: "a catalog row", to: "a catalog pick", start: catalogPicked, hit: catalogHit, vault: false, mg: 541_000, shown: "541", link: 76 },
    { from: "a catalog row", to: "a vault pick", start: catalogPicked, hit: vaultHit, vault: true, mg: 545_000, shown: "545", link: 200 },
    { from: "a vault row", to: "a catalog pick", start: vaultPicked, hit: catalogHit, vault: false, mg: 541_000, shown: "541", link: 76 },
    { from: "a vault row", to: "a vault pick", start: vaultPicked, hit: vaultHit, vault: true, mg: 545_000, shown: "545", link: 200 },
  ] as const;

  for (const c of cases) {
    it(`${c.from} → ${c.to}: the row takes the new weight, with no nudge from the old product`, async () => {
      vi.useFakeTimers();
      const w = mountRow(c.start);
      (c.vault ? vaultHits : catalogHits).push({ ...c.hit });
      await typeAndPick(w, c.hit.name.slice(0, 6));

      expect(row().unitWeightMg).toBe(c.mg);
      expect(row().catalogItemId).toBe(c.link);
      // and it survives the free-text commit that fires when focus leaves the field
      await leaveField(w);
      expect(row().unitWeightMg).toBe(c.mg);
      expect(row().catalogItemId).toBe(c.link);

      expect((w.find('input[aria-label="Weight"]').element as HTMLInputElement).value).toBe(c.shown);
      // the "suggest a fix" nudge is only honest when the baseline belongs to the
      // product now linked — a re-link that can't stamp one must not inherit the old
      expect(w.find(".item__fixrow").exists()).toBe(false);
      const baseline = row().catalogWeightMgAtLink;
      expect(baseline === undefined || baseline === c.mg).toBe(true);

      vi.useRealTimers();
      w.unmount();
    });
  }

  it("a row already nudging stops once it's renamed to a different product", async () => {
    vi.useFakeTimers();
    // the catalog says 688 g, the user weighed 700 g — the nudge is showing
    const w = mountRow({ ...catalogPicked, unitWeightMg: 700_000, weightOverridden: true });
    expect(w.find(".item__fixrow").exists()).toBe(true);
    vaultHits.push({ ...vaultHit });
    await typeAndPick(w, "Duplex");
    expect(w.find(".item__fixrow").exists()).toBe(false);
    vi.useRealTimers();
    w.unmount();
  });

  // The classification leg. The catalog's consumable category is the one that maps
  // onto a row's classification (food/fuel is never base weight); every other
  // category stays silent, because the catalog can't know how YOU carry a thing —
  // and silence must also mean "leave what's set", or re-picking a worn row would
  // quietly flip it back to base.
  it("a consumable-category pick arrives classified consumable", async () => {
    vi.useFakeTimers();
    const w = mountRow(catalogPicked);
    catalogHits.push({
      id: 300, brand: "Clif", name: "Energy Bar", variant: "single bar",
      weightMg: 68_000, verified: true, categoryHint: "consumable",
    });
    await typeAndPick(w, "Energy");
    expect(row().classification).toBe("consumable");
    expect(row().catalogItemId).toBe(300);
    vi.useRealTimers();
    w.unmount();
  });

  it("a food pick pre-fills the row's kcal from the catalog", async () => {
    vi.useFakeTimers();
    const w = mountRow(catalogPicked);
    catalogHits.push({
      id: 301, brand: "Clif", name: "Energy Bar", variant: "single bar",
      weightMg: 68_000, verified: true, categoryHint: "consumable", kcal: 250,
    });
    await typeAndPick(w, "Energy");
    expect(row().classification).toBe("consumable");
    expect(row().kcal).toBe(250);
    vi.useRealTimers();
    w.unmount();
  });

  it("a pick without kcal leaves the row's own kcal alone", async () => {
    vi.useFakeTimers();
    // a consumable row whose calories the user entered, renamed to a food row the
    // catalog has no figure for — absent must mean "keep yours", like the vault path
    const w = mountRow({ ...catalogPicked, classification: "consumable", kcal: 640 });
    catalogHits.push({
      id: 302, brand: "Knorr", name: "Rice Sides", variant: "one pouch",
      weightMg: 161_592, verified: true, categoryHint: "consumable",
    });
    await typeAndPick(w, "Rice");
    expect(row().kcal).toBe(640);
    vi.useRealTimers();
    w.unmount();
  });

  it("a non-consumable pick leaves the classification exactly as it was", async () => {
    vi.useFakeTimers();
    // an explicitly WORN row renamed to a shelter-category product must stay worn
    const w = mountRow({ ...catalogPicked, classification: "worn" });
    catalogHits.push({ ...catalogHit, categoryHint: "shelter" });
    await typeAndPick(w, "UltaMid");
    expect(row().classification).toBe("worn");
    vi.useRealTimers();
    w.unmount();
  });

  it("a free-typed 'water' lands consumable via the blur commit", async () => {
    vi.useFakeTimers();
    // type "water" and click away WITHOUT picking the water suggestion — the
    // commitFree path, which used to leave the litres row on the folder default
    const w = mountRow(catalogPicked);
    const field = w.find<HTMLInputElement>('input[role="combobox"]');
    await field.trigger("focus");
    field.element.value = "water";
    await field.trigger("input");
    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();
    await leaveField(w);
    expect(row().name).toBe("water");
    expect(row().classification).toBe("consumable");
    vi.useRealTimers();
    w.unmount();
  });
});
