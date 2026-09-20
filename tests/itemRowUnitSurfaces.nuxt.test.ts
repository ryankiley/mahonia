// @vitest-environment nuxt
//
// A row's unit picker sets the unit the row READS in (`entryUnit`, else the list's
// unit) — and everything the row says about weight has to say it in that unit, not
// just the weight cell. Three surfaces read a catalog weight beside the row:
//
//   - the "Catalog: 553 g · suggest a fix" line under a row whose weight has drifted
//     from the catalog's;
//   - the fix dialog that line opens, which restates the catalog figure and prefills
//     the row's weight as the suggestion;
//   - the catalog / My Gear autocomplete, which prints a weight beside each hit.
//
// All three used to read the LIST's unit, so a row switched to grams on a pounds
// list read "656 g" in its cell and "Catalog: 1.22 lb" underneath — the same product,
// two units, one row. Driven through the real <ItemRow> because the assertion is
// what the row renders.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { flushPromises, mount } from "@vue/test-utils";
import ItemRow from "~/components/ItemRow.vue";
import { rowProvides } from "./helpers/itemRow";
import { useCatalogCorrection } from "~/composables/useCatalogCorrection";
import type { Item, ListSnapshot } from "~~/shared/types";
import { blankList } from "./helpers/list";
import { gearListStub } from "./helpers/gearList";

// one catalog hit for the autocomplete to print a weight beside
registerEndpoint("/api/catalog/search", () => ({
  results: [
    { id: 76, brand: "Hyperlite Mountain Gear", name: "UltaMid Pyramid Tent", variant: "2 Person", weightMg: 541_000, verified: true },
  ],
}));
registerEndpoint("/api/catalog/use", { method: "POST", handler: () => ({ ok: true }) });

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(false),
  vaultKnown: ref(true),
  vaultFetch: <T,>() => Promise.resolve({} as T),
}));

// a pounds list — the unit the row is NOT in
const snapshot = ref<ListSnapshot>(blankList({ displayUnit: "lb" }));
mockNuxtImport("useGearList", () => () => gearListStub({ snapshot }));

// the chair from the catalog at 553 g, weighed at home at 656 g, and switched to
// read in grams — the nudge is showing
const chair: Item = {
  id: "i1",
  folderId: "f1",
  name: "Moonlite Elite Reclining Chair",
  brand: "Nemo",
  unitWeightMg: 656_000,
  weightOverridden: true,
  entryUnit: "g",
  catalogItemId: 12,
  catalogWeightMgAtLink: 553_000,
  qty: 1,
  classification: null,
  sortOrder: 0,
};

function mountRow(item: Item) {
  snapshot.value = { ...blankList({ displayUnit: "lb" }), items: [{ ...item }] } as ListSnapshot;
  return mount(ItemRow, {
    props: {
      get list() {
        return snapshot.value;
      },
      get item() {
        return snapshot.value.items[0]!;
      },
    },
    global: { provide: rowProvides() },
    attachTo: document.body,
  });
}

describe("a row reading in grams on a pounds list", () => {
  beforeEach(() => {
    useCatalogCorrection().close();
  });

  it("nudges in grams too: the catalog figure under the row reads in the row's unit", () => {
    const w = mountRow(chair);
    expect(w.find(".item__fixrow").text()).toContain("Catalog: 553 g");
    w.unmount();
  });

  it("opens the fix dialog in grams, so the prefilled suggestion and the row agree", async () => {
    const w = mountRow(chair);
    await w.find(".item__under-link").trigger("click");
    const { target } = useCatalogCorrection();
    expect(target.value?.displayUnit).toBe("g");
    expect(target.value?.catalogWeightMg).toBe(553_000);
    expect(target.value?.suggestedMg).toBe(656_000);
    w.unmount();
  });

  it("prints the autocomplete's weights in grams", async () => {
    vi.useFakeTimers();
    const w = mountRow(chair);
    const field = w.find<HTMLInputElement>('input[role="combobox"]');
    await field.trigger("focus");
    field.element.value = "Ulta";
    await field.trigger("input");
    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();
    expect(w.find(".ac__w").text()).toBe("541 g");
    vi.useRealTimers();
    w.unmount();
  });

  // the control: a row with no unit of its own still reads in the list's
  it("falls back to the list's unit on a row with no unit of its own", () => {
    const w = mountRow({ ...chair, entryUnit: undefined });
    expect(w.find(".item__fixrow").text()).toContain("Catalog: 1.22 lb");
    w.unmount();
  });
});
