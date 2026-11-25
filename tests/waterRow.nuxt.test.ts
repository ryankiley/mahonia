// THE WATER ROW'S LITRES FIELD. Water is a volume, never a count (foldWaterQty,
// shared/ops), so the field reads and writes the row's WHOLE volume, takes a volume
// typed the way the name box takes one ("32 oz"), and stands in for the stepper on any
// name that reads as water, not just "Water".
//
// Rendered through the real <ItemRow> over the stub controller, whose updateItem runs
// the real reducer, so what the field writes is what the list would store.
import { afterEach, describe, expect, it } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount } from "@vue/test-utils";
import { mountRowOver, rowProvides } from "./helpers/itemRow";
import type { Item, ListSnapshot } from "~~/shared/types";
import { blankList, item } from "./helpers/list";
import { gearListStub, quietVaultAccess } from "./helpers/gearList";

registerEndpoint("/api/catalog/search", () => ({ results: [] }));
registerEndpoint("/api/catalog/use", { method: "POST", handler: () => ({ ok: true }) });
mockNuxtImport("useVaultAccess", () => () => quietVaultAccess());

const snapshot = ref<ListSnapshot>(blankList());
mockNuxtImport("useGearList", () => () => gearListStub({ snapshot }));
enableAutoUnmount(afterEach);

const water = (over: Partial<Item> = {}) =>
  item({ id: "w", name: "Water", unitWeightMg: 3_000_000, classification: "consumable", ...over });
const mountRow = (row: Item) => mountRowOver(snapshot, [{ ...row }], rowProvides());
const litres = (w: ReturnType<typeof mountRow>) => w.find('input[aria-label="Litres of water"]');
const weight = (w: ReturnType<typeof mountRow>) => (w.find('input[aria-label="Weight"]').element as HTMLInputElement).value;
// setValue fires the field's change itself; a second trigger would re-read the litres
// the handler just wrote back ("0.95"), which no person's single commit does
const type = (w: ReturnType<typeof mountRow>, text: string) => litres(w).setValue(text);

describe("the water row's litres field", () => {
  it("reads the whole row, so a count stored before the fold can't hide behind it", () => {
    const w = mountRow(water({ qty: 3 }));
    expect((litres(w).element as HTMLInputElement).value).toBe("9");
    expect(weight(w)).toBe("9,000");
  });

  it("writes the whole volume at qty 1", async () => {
    const w = mountRow(water({ qty: 3 }));
    await type(w, "3");
    expect(snapshot.value.items[0]).toMatchObject({ qty: 1, unitWeightMg: 3_000_000 });
  });

  it("takes a volume typed in fluid ounces or millilitres, and still shows litres", async () => {
    const w = mountRow(water());
    await type(w, "32 oz");
    expect(snapshot.value.items[0]!.unitWeightMg).toBe(946_352);
    expect((litres(w).element as HTMLInputElement).value).toBe("0.95");
    await type(w, "500 ml");
    expect(snapshot.value.items[0]!.unitWeightMg).toBe(500_000);
    await type(w, "1,5");
    expect(snapshot.value.items[0]!.unitWeightMg).toBe(1_500_000);
  });

  it("clears on empty or zero, and puts the figure back on anything that isn't a volume", async () => {
    const w = mountRow(water());
    await type(w, "banana");
    expect(snapshot.value.items[0]!.unitWeightMg).toBe(3_000_000);
    expect((litres(w).element as HTMLInputElement).value).toBe("3");
    await type(w, "");
    expect(snapshot.value.items[0]!.unitWeightMg).toBe(0);
  });

  it("stands in for the stepper on any name that reads as water, and only those", () => {
    for (const name of ["Drinking water", "Water (2 L)", "Spare water"]) {
      const w = mountRow(water({ name }));
      expect(litres(w).exists(), name).toBe(true);
      expect(w.find('input[aria-label="Quantity"]').exists(), name).toBe(false);
      w.unmount();
    }
    for (const name of ["Water filter", "Water bottle", "Smartwater"]) {
      const w = mountRow(item({ id: "g", name, unitWeightMg: 65_000 }));
      expect(litres(w).exists(), name).toBe(false);
      expect(w.find('input[aria-label="Quantity"]').exists(), name).toBe(true);
      w.unmount();
    }
  });
});
