// THE CALORIE FIELD ON A FUEL ROW. A row's class popover holds the choice and, once the
// row is consumable, a "kcal each" field — and the number typed there is food energy:
// the totals bar counts it and the food plan divides it by the days. A gas canister is a
// consumable too, and a field asking for its calories is an invitation to type the
// ~1,350 kcal of isobutane in a 110 g can, which the plan then serves as a day's ration.
//
// So a row that reads as stove fuel (isFuelRow, the same rule that draws its fuel can)
// is offered the choice alone — UNLESS it already carries a number. A stored value keeps
// counting, as Item.kcal says every stored value does, so it keeps the one field that can
// clear it (offersKcal has the argument). The three rows below are the three states.
//
// WORN IS OFFERED ON FUEL like on any row. It used to be withheld (nobody wears a gas
// canister), which made fuel's the one card of a different shape, and the fuel rule also
// reads a fuel bottle and a gas stove as fuel. Water is the row with no choice at all:
// its class is fixed, and its mark is a plain droplet that opens nothing.
//
// AND AN OPEN POPOVER KEEPS THE FIELD IT OPENED WITH. The kcal field's rule reads the row
// as stored, and clearing the number or a name commit can change that with the cursor in
// the field. So it is decided when the popover opens and held until it closes.
//
// Rendered through the real <ItemRow>, because what is under test is which branch of the
// template draws.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount } from "@vue/test-utils";
import { mountRowOver } from "./helpers/itemRow";
import type { Item, ListSnapshot } from "~~/shared/types";
import { blankList, item as baseItem } from "./helpers/list";
import { gearListStub, quietVaultAccess } from "./helpers/gearList";
import { useItemMenu } from "~/composables/useItemMenu";

registerEndpoint("/api/catalog/search", () => ({ results: [] }));
registerEndpoint("/api/catalog/use", { method: "POST", handler: () => ({ ok: true }) });

mockNuxtImport("useVaultAccess", () => () => quietVaultAccess());

const snapshot = ref<ListSnapshot>(blankList());
mockNuxtImport("useGearList", () => () => gearListStub({ snapshot }));

enableAutoUnmount(afterEach);

// every row here is in the consumable folder's world, so consumable is the default
const item = (over: Partial<Item> & { id: string }): Item => baseItem({ classification: "consumable", ...over });

const mountRow = (row: Item) => mountRowOver(snapshot, [{ ...row }]);

// open the popover, then answer for what it holds
async function openPop(w: ReturnType<typeof mountRow>) {
  await w.get('button[aria-label^="Consumable for "]').trigger("click");
  await nextTick();
  const pop = w.get('[role="dialog"][aria-label="Counts as"]');
  return {
    hasChoice: pop.find('[role="radio"][aria-label^="Consumable"]').exists(),
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
    expect(pop.hasChoice).toBe(true);
    expect(pop.field.exists()).toBe(true);
  });

  it("asks for kcal each only where the row has several", async () => {
    for (const [qty, label] of [[1, "kcal"], [3, "kcal each"]] as const) {
      const w = mountRow(item({ id: "dinner", name: "Chicken Pesto Pasta", unitWeightMg: 130_000, qty }));
      await openPop(w);
      expect(w.get('label[for="dinner-kcal"]').text(), String(qty)).toBe(label);
      w.unmount();
      useItemMenu().close();
    }
  });

  it("is withheld on fuel holding no number — the choice stays", async () => {
    for (const fuel of [
      item({ id: "gas", name: "IsoPro Fuel Canister", brand: "MSR", commonName: "Fuel canister", unitWeightMg: 110_000 }),
      item({ id: "propane", name: "Propane 1 lb", unitWeightMg: 460_000 }),
    ]) {
      const w = mountRow(fuel);
      const pop = await openPop(w);
      expect(pop.hasChoice).toBe(true);
      expect(pop.field.exists(), fuel.name).toBe(false);
      w.unmount();
    }
  });

  it("stays on fuel that already carries a value, with the number in it, so it can be cleared", async () => {
    const w = mountRow(item({ id: "gas", name: "Gas canister", unitWeightMg: 210_000, kcal: 1350 }));
    const pop = await openPop(w);
    expect(pop.field.exists()).toBe(true);
    expect(pop.field.element.value).toBe("1350");
  });
});

describe("the simple cooking estimate", () => {
  beforeEach(() => useItemMenu().close());

  it("reveals the cooking toggle only after Consumable is chosen, without adding calculator inputs", async () => {
    const w = mountRow(item({ id: "meal", name: "Pasta", classification: "base", qty: 6, unitWeightMg: 100_000, kcal: 400 }));
    await w.get('button[aria-label="Base weight for Pasta"]').trigger("click");
    const pop = w.get('[role="dialog"][aria-label="Counts as"]');
    const consumable = pop.get('[role="radio"][aria-label^="Consumable"]');
    const base = pop.get('[role="radio"][aria-label^="Base"]');
    expect(pop.find('[aria-label="Needs cooking"]').exists()).toBe(false);
    await consumable.trigger("click");
    const cooking = pop.get('[role="switch"][aria-label="Needs cooking"]');
    expect(cooking.attributes("aria-checked")).toBe("false");
    expect(pop.find('[role="status"]').exists()).toBe(false);
    await cooking.trigger("click");
    expect(cooking.attributes("aria-checked")).toBe("true");
    expect(pop.get('[role="status"]').text()).toBe("~60 g fuel for 6 boils");
    expect(pop.get('[role="status"]').attributes("title")).toBe("Assumes one boil per item, at 10 g per boil.");
    expect(pop.findAll("input")).toHaveLength(1); // just the existing kcal field
    expect(w.findAll('[role="dialog"]')).toHaveLength(1);
    expect(snapshot.value.items[0]).toMatchObject({ qty: 6, unitWeightMg: 100_000, kcal: 400, needsCooking: true });

    // Class changes hide the estimate without losing this trip's preparation choice.
    await base.trigger("click");
    expect(pop.find('[aria-label="Needs cooking"]').exists()).toBe(false);
    expect(pop.find('[role="status"]').exists()).toBe(false);
    expect(snapshot.value.items[0]!.needsCooking).toBe(true);
    await consumable.trigger("click");
    expect(pop.get('[role="status"]').text()).toContain("~60 g fuel");
    await pop.get('[aria-label="Needs cooking"]').trigger("click");
    expect(pop.find('[role="status"]').exists()).toBe(false);
    expect(snapshot.value.items[0]!.needsCooking).toBeUndefined();
    expect(snapshot.value.items[0]).toMatchObject({ qty: 6, unitWeightMg: 100_000, kcal: 400 });
  });

  it.each([0, 1, 6, 9999])("assumes one boil per unit at quantity %i", async (qty) => {
    const w = mountRow(item({ id: "meal", name: "Pasta", qty, needsCooking: true }));
    await openPop(w);
    const estimate = () => w.get('[role="dialog"][aria-label="Counts as"] [role="status"]').text();
    expect(estimate()).toBe(`~${qty * 10} g fuel for ${qty} ${qty === 1 ? "boil" : "boils"}`);
    snapshot.value.items[0]!.qty = 2;
    await nextTick();
    expect(estimate()).toBe("~20 g fuel for 2 boils");
  });

  it("does not offer cooking on stove fuel or water", async () => {
    const fuel = mountRow(item({ id: "gas", name: "Gas canister", kcal: 1350 }));
    await openPop(fuel);
    expect(fuel.find('[aria-label="Needs cooking"]').exists()).toBe(false);
    fuel.unmount();
    const water = mountRow(item({ id: "water", name: "Water" }));
    expect(water.find('button[aria-label^="Consumable"]').exists()).toBe(false);
    expect(water.find('[aria-label="Needs cooking"]').exists()).toBe(false);
  });
});

// SCOPED TO THE ROW: a parent renders its children as more <ItemRow>s, so an unscoped
// find could answer for a child — none here have children, but the habit is the point.
const classMark = (w: ReturnType<typeof mountRow>) => w.find(".item-row").find(".item__clsbtn");

describe("the choice on fuel and water", () => {
  beforeEach(() => {
    snapshot.value = blankList();
    useItemMenu().close();
  });

  it("is all three on fuel, whatever the row's class", async () => {
    for (const fuel of [
      item({ id: "gas", name: "IsoPro Fuel Canister", commonName: "Fuel canister", unitWeightMg: 110_000 }),
      item({ id: "gas", name: "Gas canister", unitWeightMg: 210_000, classification: null }),
      item({ id: "gas", name: "Propane 1 lb", unitWeightMg: 460_000, classification: "base" }),
      item({ id: "gas", name: "Gas canister", unitWeightMg: 210_000, classification: "worn" }),
    ]) {
      const w = mountRow(fuel);
      await classMark(w).trigger("click");
      await nextTick();
      expect(w.findAll('[role="radio"]').map((o) => o.text()), fuel.name).toEqual(["Base", "Worn", "Consumable"]);
      w.unmount();
      useItemMenu().close();
    }
  });

  it("is not there on water: one plain droplet, no plate, nothing to press", () => {
    const w = mountRow(item({ id: "water", name: "Water" }));
    expect(classMark(w).exists()).toBe(false);
    const mark = w.find(".item-row").get(".item__clsfixed");
    expect(mark.attributes("aria-label")).toBe("Consumable");
    expect(mark.classes()).not.toContain("item__mark");
    expect(w.find(".item-row").findAll(".item__classcell .item__cls")).toHaveLength(1);
  });
});

describe("an open popover keeps the controls it opened with", () => {
  beforeEach(() => {
    snapshot.value = blankList();
    useItemMenu().close();
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
    expect(pop.hasChoice).toBe(true);
    expect(pop.field.exists()).toBe(false);
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
  });
});
