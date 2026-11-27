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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { mountRowOver } from "./helpers/itemRow";
import { useCatalogCorrection } from "~/composables/useCatalogCorrection";
import type { Item, ListSnapshot } from "~~/shared/types";
import { blankList } from "./helpers/list";
import { gearListStub, quietVaultAccess } from "./helpers/gearList";

// one catalog hit for the autocomplete to print a weight beside
registerEndpoint("/api/catalog/search", () => ({
  results: [
    { id: 76, brand: "Hyperlite Mountain Gear", name: "UltaMid Pyramid Tent", variant: "2 Person", weightMg: 541_000, verified: true },
  ],
}));
registerEndpoint("/api/catalog/use", { method: "POST", handler: () => ({ ok: true }) });

mockNuxtImport("useVaultAccess", () => () => quietVaultAccess());

// a pounds list — the unit the row is NOT in
const snapshot = ref<ListSnapshot>(blankList({ displayUnit: "lb" }));
mockNuxtImport("useGearList", () => () => gearListStub({ snapshot }));

enableAutoUnmount(afterEach);

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

const mountRow = (item: Item) => mountRowOver(snapshot, [{ ...item }], undefined, { displayUnit: "lb" });

describe("a row reading in grams on a pounds list", () => {
  beforeEach(() => {
    useCatalogCorrection().close();
  });

  it("nudges in grams too: the catalog figure under the row reads in the row's unit", () => {
    const w = mountRow(chair);
    expect(w.get(".item__catnote-btn").attributes("aria-label")).toContain("Catalog: 553 g");
  });

  it("opens the fix dialog in grams, so the prefilled suggestion and the row agree", async () => {
    const w = mountRow(chair);
    await w.get(".item__catnote-btn").trigger("click");
    await w.get(".item__fixsuggest").trigger("click");
    const { target } = useCatalogCorrection();
    expect(target.value?.displayUnit).toBe("g");
    expect(target.value?.catalogWeightMg).toBe(553_000);
    expect(target.value?.suggestedMg).toBe(656_000);
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
  });

  // the control: a row with no unit of its own still reads in the list's
  it("falls back to the list's unit on a row with no unit of its own", () => {
    const w = mountRow({ ...chair, entryUnit: undefined });
    expect(w.get(".item__catnote-btn").attributes("aria-label")).toContain("Catalog: 1.22 lb");
  });
});

// The note is for a weight that DISAGREES with the catalog's, and whether it does is
// judged as the row reads. Grams print no decimals: a tent the catalog holds at
// 887,340 mg, imported at 887,000, read "887 g" in its cell and "Catalog: 887 g ·
// suggest a fix" underneath.
describe("a catalog weight the row cannot tell from its own", () => {
  const tent: Item = { ...chair, unitWeightMg: 887_000, catalogWeightMgAtLink: 887_340 };

  it.each(["g", "oz", "lb", "kg"] as const)("raises no note where both read the same in %s", (entryUnit) => {
    const w = mountRow({ ...tent, entryUnit });
    expect(w.find(".item__catnote").exists()).toBe(false);
  });

  it("still raises it for a gram the row's unit shows, and not in a unit that hides it", () => {
    const off = { ...tent, catalogWeightMgAtLink: 888_000 };
    expect(mountRow({ ...off, entryUnit: "g" }).get(".item__catnote-btn").attributes("aria-label")).toContain("Catalog: 888 g");
    // 0.89 kg both ways
    expect(mountRow({ ...off, entryUnit: "kg" }).find(".item__catnote").exists()).toBe(false);
  });
});
