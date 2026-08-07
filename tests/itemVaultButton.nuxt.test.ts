// @vitest-environment nuxt
//
// The row's "Save to My Gear" button, in the state where it must NOT act: a list
// whose gear the automatic capture path already banks (the vault answer is yes).
// Offering to save what's saved is a placebo — the button's press "succeeded"
// while changing nothing — so on a covered row it stands down: aria-disabled, its
// words flipped to "Already in My Gear", and its click a no-op.
//
// Nuxt environment because the decision under test is what the ROW renders: which
// label, which ARIA state, and whether a press still reaches the controller. The
// condition spans the controller's mirror (vaultAuto / vaultDeclined), the session
// (hasVault), and the row's own worthiness — gearList.nuxt.test.ts proves the
// mirror tracks the stored answer; this file proves the button obeys the mirror.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { mount } from "@vue/test-utils";
import ItemRow from "~/components/ItemRow.vue";
import type { Item, ListSnapshot } from "~~/shared/types";
import { vaultNormKey } from "~~/shared/vault";

// The three dials the covered state reads, reset per test.
const vaultAuto = ref(false);
const vaultDeclined = ref<Set<string>>(new Set());
const hasVault = ref(true);
const saveItemToVault = vi.fn(() => Promise.resolve("saved" as const));

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault,
  vaultFetch: () => Promise.resolve({ results: [] }),
}));

mockNuxtImport("useGearList", () => () => ({
  pendingBlankId: ref<string | null>(null),
  updateItem: () => {},
  setItemWeight: () => {},
  removeItem: () => {},
  moveItem: () => {},
  discardEmpty: () => {},
  addBlankItemAfter: () => "",
  addChild: () => "",
  nestItem: () => {},
  unnest: () => {},
  saveItemToVault,
  vaultAuto,
  vaultDeclined,
}));

const list = {
  id: "l1",
  name: "Test",
  displayUnit: "g",
  folders: [{ id: "f1", name: "Shelter", sortOrder: 0 }],
  items: [],
} as unknown as ListSnapshot;

// a row capture would take: named, weighed, no children
const gear = (over: Partial<Item> = {}): Item => ({
  id: "i1",
  folderId: "f1",
  name: "Duplex",
  brand: "Zpacks",
  unitWeightMg: 539_000,
  qty: 1,
  classification: null,
  sortOrder: 0,
  ...over,
});

function mountRow(item: Item) {
  return mount(ItemRow, {
    props: { list, item, childrenByParent: new Map() },
    attachTo: document.body,
  });
}

const vaultBtn = (w: ReturnType<typeof mountRow>) => w.find(".item__vault-btn");

describe("the save button on a list the automatic capture already covers", () => {
  beforeEach(() => {
    vaultAuto.value = false;
    vaultDeclined.value = new Set();
    hasVault.value = true;
    saveItemToVault.mockClear();
  });

  it("stands down — aria-disabled, 'Already in My Gear', and a dead click", async () => {
    vaultAuto.value = true;
    const w = mountRow(gear());
    const btn = vaultBtn(w);
    expect(btn.attributes("aria-disabled")).toBe("true");
    expect(btn.attributes("aria-label")).toBe("Already in My Gear");
    // aria-disabled, NOT disabled: the button stays focusable so the tooltip —
    // the whole explanation — remains reachable without a mouse
    expect(btn.attributes("disabled")).toBeUndefined();

    await btn.trigger("click");
    expect(saveItemToVault).not.toHaveBeenCalled();

    // the mobile ⋯ menu carries the same state as a disabled row, since a
    // phone has no tooltip to say it with
    await w.find(".item__morebtn").trigger("click");
    const entry = w
      .findAll(".item__morelist .menu__item")
      .find((b) => b.text() === "Already in My Gear")!;
    expect(entry.attributes("disabled")).toBeDefined();
    w.unmount();
  });

  it("stays a live action for a row the chooser declined", async () => {
    vaultAuto.value = true;
    const item = gear();
    vaultDeclined.value = new Set([vaultNormKey(item.brand, item.name, item.variant)]);
    const w = mountRow(item);
    const btn = vaultBtn(w);
    expect(btn.attributes("aria-disabled")).toBeUndefined();
    expect(btn.attributes("aria-label")).toBe("Save to My Gear");
    // pressing it is the one way a declined row gets banked
    await btn.trigger("click");
    expect(saveItemToVault).toHaveBeenCalledOnce();
    w.unmount();
  });

  it("claims nothing for a row capture wouldn't take", () => {
    vaultAuto.value = true;
    // no weight and no catalog link — isVaultWorthy says "still a half-typed
    // thought", so the automatic path skips it and "already in" would be a lie
    const w = mountRow(gear({ unitWeightMg: 0 }));
    expect(vaultBtn(w).attributes("aria-disabled")).toBeUndefined();
    expect(vaultBtn(w).attributes("aria-label")).toBe("Save to My Gear");
    w.unmount();
  });

  it("does not render at all on a water row — inline or in the ⋯ menu", async () => {
    // water is never vault-worthy (isVaultWorthy → isWaterRow), so before this
    // rule the inline button's only possible outcome was the "give it a name and
    // a weight" toast — on a row that has both. The ⋯ menu already ruled water
    // out; the inline button now follows the same rule.
    vaultAuto.value = true; // covered or not, there is nothing to render
    const w = mountRow(gear({ name: "Water", brand: undefined, classification: "consumable" }));
    expect(vaultBtn(w).exists()).toBe(false);
    await w.find(".item__morebtn").trigger("click");
    const labels = w.findAll(".item__morelist .menu__item").map((b) => b.text());
    expect(labels.some((l) => l.includes("My Gear"))).toBe(false);
    w.unmount();
  });

  it("claims nothing signed out — there is no vault for the gear to already be in", () => {
    vaultAuto.value = true;
    hasVault.value = false;
    const w = mountRow(gear());
    expect(vaultBtn(w).attributes("aria-disabled")).toBeUndefined();
    w.unmount();
  });

  it("still banks a row by hand on an uncovered list, and says so", async () => {
    const w = mountRow(gear());
    const btn = vaultBtn(w);
    expect(btn.attributes("aria-label")).toBe("Save to My Gear");
    await btn.trigger("click");
    expect(saveItemToVault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(vaultBtn(w).attributes("aria-label")).toBe("Saved to My Gear"));
    w.unmount();
  });
});
