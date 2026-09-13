// @vitest-environment nuxt
//
// THE CALORIE FIELD ON A FUEL ROW. A row's consumable popover holds the switch and, once
// the row is consumable, a "kcal each" field — and the number typed there is food energy:
// the totals bar counts it and the food plan divides it by the days. A gas canister is a
// consumable too, and a field asking for its calories is an invitation to type the
// ~1,350 kcal of isobutane in a 110 g can, which the plan then serves as a day's ration.
//
// So a row that reads as stove fuel (isFuelRow, the same rule that draws its fuel can)
// is offered the switch alone — UNLESS it already carries a number. A stored value keeps
// counting, as Item.kcal says every stored value does, so it keeps the one field that can
// clear it (offersKcal has the argument). The three rows below are the three states.
//
// THE WORN TOGGLE follows the same shape (wornOffered): nobody wears a gas canister, so a
// fuel row draws no worn toggle — a ghost shirt holds the slot, as it does for water —
// unless the row already says worn, in which case the toggle stays so it can be undone.
//
// AND AN OPEN POPOVER KEEPS THE CONTROLS IT OPENED WITH. Undoing worn happens INSIDE the
// worn popover, and the popover lives in the root the toggle's rule gates: the first cut
// of that rule unmounted the popover from inside its own switch, with the menu singleton
// still holding its id, the folder's overlay lift never returned and focus dropped to the
// body. The kcal field held the same trap through the name commit the field's own focus
// causes. So both are decided when a popover opens and held until it closes.
//
// Rendered through the real <ItemRow>, because what is under test is which branch of the
// template draws.
import { beforeEach, describe, expect, it } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { mount } from "@vue/test-utils";
import ItemRow from "~/components/ItemRow.vue";
import { rowProvides } from "./helpers/itemRow";
import type { Item, ListSnapshot } from "~~/shared/types";
import { blankList } from "./helpers/list";
import { gearListStub } from "./helpers/gearList";
import { useItemMenu } from "~/composables/useItemMenu";

registerEndpoint("/api/catalog/search", () => ({ results: [] }));
registerEndpoint("/api/catalog/use", { method: "POST", handler: () => ({ ok: true }) });

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(false),
  vaultKnown: ref(true),
  vaultFetch: <T,>() => Promise.resolve({} as T),
}));

const snapshot = ref<ListSnapshot>(blankList());
mockNuxtImport("useGearList", () => () => gearListStub({ snapshot }));

const item = (over: Partial<Item> & { id: string }): Item => ({
  folderId: "f1",
  parentId: null,
  name: "",
  unitWeightMg: 0,
  qty: 1,
  classification: "consumable",
  sortOrder: 0,
  ...over,
});

function mountRow(row: Item) {
  snapshot.value = { ...blankList(), items: [{ ...row }] } as ListSnapshot;
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

// open the popover, then answer for what it holds
async function openPop(w: ReturnType<typeof mountRow>) {
  await w.get('button[aria-label="Consumable: yes"]').trigger("click");
  await nextTick();
  const pop = w.get('[role="dialog"][aria-label="Consumable"]');
  return {
    hasSwitch: pop.find('[role="switch"]').exists(),
    field: pop.find<HTMLInputElement>('input[id$="-kcal"]'),
  };
}

describe("the calorie field on a fuel row", () => {
  beforeEach(() => {
    snapshot.value = blankList();
  });

  it("is offered on food", async () => {
    const w = mountRow(item({ id: "dinner", name: "Chicken Pesto Pasta", commonName: "Meal", unitWeightMg: 130_000 }));
    const pop = await openPop(w);
    expect(pop.hasSwitch).toBe(true);
    expect(pop.field.exists()).toBe(true);
    w.unmount();
  });

  it("is withheld on fuel holding no number — the switch stays", async () => {
    for (const fuel of [
      item({ id: "gas", name: "IsoPro Fuel Canister", brand: "MSR", commonName: "Fuel canister", unitWeightMg: 110_000 }),
      item({ id: "propane", name: "Propane 1 lb", unitWeightMg: 460_000 }),
    ]) {
      const w = mountRow(fuel);
      const pop = await openPop(w);
      expect(pop.hasSwitch).toBe(true);
      expect(pop.field.exists(), fuel.name).toBe(false);
      w.unmount();
    }
  });

  it("stays on fuel that already carries a value, with the number in it, so it can be cleared", async () => {
    const w = mountRow(item({ id: "gas", name: "Gas canister", unitWeightMg: 210_000, kcal: 1350 }));
    const pop = await openPop(w);
    expect(pop.field.exists()).toBe(true);
    expect(pop.field.element.value).toBe("1350");
    w.unmount();
  });
});

describe("the simple cooking estimate", () => {
  beforeEach(() => useItemMenu().close());

  it("reveals the cooking toggle only after Consumable is on, without adding calculator inputs", async () => {
    const w = mountRow(item({ id: "meal", name: "Pasta", classification: "base", qty: 6, unitWeightMg: 100_000, kcal: 400 }));
    await w.get('button[aria-label="Consumable: no"]').trigger("click");
    const pop = w.get('[role="dialog"][aria-label="Consumable"]');
    const consumable = pop.get('[role="switch"][aria-label^="Consumable"]');
    expect(pop.find('[aria-label="Needs cooking"]').exists()).toBe(false);
    await consumable.trigger("click");
    const cooking = pop.get('[role="switch"][aria-label="Needs cooking"]');
    expect(cooking.attributes("aria-checked")).toBe("false");
    expect(pop.find('[role="status"]').exists()).toBe(false);
    await cooking.trigger("click");
    expect(cooking.attributes("aria-checked")).toBe("true");
    expect(pop.get('[role="status"]').text()).toBe("~60 g fuel");
    expect(pop.get('[role="status"]').attributes("title")).toBe("Assumes one boil per item, at 10 g per boil.");
    expect(pop.findAll("input")).toHaveLength(1); // just the existing kcal field
    expect(w.findAll('[role="dialog"]')).toHaveLength(1);
    expect(snapshot.value.items[0]).toMatchObject({ qty: 6, unitWeightMg: 100_000, kcal: 400, needsCooking: true });

    // Class changes hide the estimate without losing this trip's preparation choice.
    await consumable.trigger("click");
    expect(pop.find('[aria-label="Needs cooking"]').exists()).toBe(false);
    expect(pop.find('[role="status"]').exists()).toBe(false);
    expect(snapshot.value.items[0]!.needsCooking).toBe(true);
    await consumable.trigger("click");
    expect(pop.get('[role="status"]').text()).toContain("~60 g fuel");
    await pop.get('[aria-label="Needs cooking"]').trigger("click");
    expect(pop.find('[role="status"]').exists()).toBe(false);
    expect(snapshot.value.items[0]!.needsCooking).toBeUndefined();
    expect(snapshot.value.items[0]).toMatchObject({ qty: 6, unitWeightMg: 100_000, kcal: 400 });
    w.unmount();
  });

  it.each([0, 1, 6, 9999])("assumes one boil per unit at quantity %i", async (qty) => {
    const w = mountRow(item({ id: "meal", name: "Pasta", qty, needsCooking: true }));
    await openPop(w);
    const estimate = () => w.get('[role="dialog"][aria-label="Consumable"] [role="status"]').text();
    expect(estimate()).toBe(`~${qty * 10} g fuel`);
    snapshot.value.items[0]!.qty = 2;
    await nextTick();
    expect(estimate()).toBe("~20 g fuel");
    w.unmount();
  });

  it("does not offer cooking on stove fuel or water", async () => {
    const fuel = mountRow(item({ id: "gas", name: "Gas canister", kcal: 1350 }));
    await openPop(fuel);
    expect(fuel.find('[aria-label="Needs cooking"]').exists()).toBe(false);
    fuel.unmount();
    const water = mountRow(item({ id: "water", name: "Water" }));
    expect(water.find('button[aria-label^="Consumable"]').exists()).toBe(false);
    expect(water.find('[aria-label="Needs cooking"]').exists()).toBe(false);
    water.unmount();
  });
});

// SCOPED TO THE ROW: a parent renders its children as more <ItemRow>s, so an unscoped
// find could answer for a child — none here have children, but the habit is the point.
const wornToggle = (w: ReturnType<typeof mountRow>) => w.find(".item-row").find('button[aria-label^="Worn"]');
const ghostShirt = (w: ReturnType<typeof mountRow>) => w.find(".item-row").find(".item__clsghost");

describe("the worn toggle on a fuel row", () => {
  beforeEach(() => {
    snapshot.value = blankList();
  });

  it("is drawn on food", () => {
    const w = mountRow(item({ id: "bar", name: "Clif bar", unitWeightMg: 68_000 }));
    expect(wornToggle(w).exists()).toBe(true);
    expect(ghostShirt(w).exists()).toBe(false);
    w.unmount();
  });

  it("gives way to the ghost slot on fuel, whatever the row's class", () => {
    for (const fuel of [
      item({ id: "gas", name: "IsoPro Fuel Canister", commonName: "Fuel canister", unitWeightMg: 110_000 }),
      item({ id: "gas", name: "Gas canister", unitWeightMg: 210_000, classification: null }),
      item({ id: "gas", name: "Propane 1 lb", unitWeightMg: 460_000, classification: "base" }),
    ]) {
      const w = mountRow(fuel);
      expect(wornToggle(w).exists(), fuel.name).toBe(false);
      expect(ghostShirt(w).exists(), fuel.name).toBe(true);
      w.unmount();
    }
  });

  it("stays on fuel a row already says is worn — by class or by a split — so it can be undone", () => {
    for (const worn of [
      item({ id: "gas", name: "Gas canister", unitWeightMg: 210_000, classification: "worn" }),
      item({ id: "gas", name: "Gas canister", unitWeightMg: 210_000, classification: "base", qty: 2, wornQty: 1 }),
    ]) {
      const w = mountRow(worn);
      expect(wornToggle(w).exists()).toBe(true);
      expect(ghostShirt(w).exists()).toBe(false);
      w.unmount();
    }
  });
});

describe("an open popover keeps the controls it opened with", () => {
  beforeEach(() => {
    snapshot.value = blankList();
    useItemMenu().close();
  });

  it("undoing worn inside the worn popover leaves the popover standing, and the toggle goes when it closes", async () => {
    const w = mountRow(item({ id: "gas", name: "Gas canister", unitWeightMg: 210_000, classification: "worn" }));
    const row = () => snapshot.value.items[0]!;
    await w.get('button[aria-label^="Worn"]').trigger("click");
    await nextTick();
    const pop = () => w.find('[role="dialog"][aria-label="Worn"]');
    expect(pop().exists()).toBe(true);
    expect(w.emitted("overlayToggle")).toEqual([[true]]);

    await pop().get('[role="switch"]').trigger("click");
    await nextTick();
    // the row is no longer worn — and nothing was pulled out from under the click
    expect(row().classification).toBeNull();
    expect(pop().exists()).toBe(true);
    expect(wornToggle(w).exists()).toBe(true);
    expect(useItemMenu().openId.value).toBe("gas:worn");

    // closing is what takes the toggle away — and rebalances the folder's overlay count
    useItemMenu().close();
    await nextTick();
    expect(pop().exists()).toBe(false);
    expect(wornToggle(w).exists()).toBe(false);
    expect(ghostShirt(w).exists()).toBe(true);
    expect(w.emitted("overlayToggle")).toEqual([[true], [false]]);
    w.unmount();
  });

  it("clearing a fuel row's calories keeps the field for the rest of the visit; the next open withholds it", async () => {
    const w = mountRow(item({ id: "gas", name: "Gas canister", unitWeightMg: 210_000, kcal: 1350 }));
    const row = () => snapshot.value.items[0]!;
    let pop = await openPop(w);
    expect(pop.field.exists()).toBe(true);

    pop.field.element.value = "";
    await pop.field.trigger("change");
    await nextTick();
    expect(row().kcal).toBeUndefined();
    // still there — an empty box the visit can type into again, not a control gone under the hand
    expect(w.find('input[id$="-kcal"]').exists()).toBe(true);

    useItemMenu().close();
    await nextTick();
    pop = await openPop(w);
    expect(pop.hasSwitch).toBe(true);
    expect(pop.field.exists()).toBe(false);
    w.unmount();
  });

  it("takes a number back the way the popover prints it", async () => {
    const w = mountRow(item({ id: "gas", name: "Gas canister", unitWeightMg: 210_000, qty: 2, kcal: 1350 }));
    const row = () => snapshot.value.items[0]!;
    const pop = await openPop(w);
    // the line under the field reads "2,700 kcal for 2"; a thousands separator typed
    // back must not be read as "unparseable" and clear the number
    pop.field.element.value = "1,400";
    await pop.field.trigger("change");
    await nextTick();
    expect(row().kcal).toBe(1400);
    expect(w.find('input[id$="-kcal"]').exists()).toBe(true);
    w.unmount();
  });
});
