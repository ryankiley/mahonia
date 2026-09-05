// @vitest-environment nuxt
//
// The unit picker on a GROUP row — the row whose weight column shows a total rather
// than something anybody typed.
//
// It was excluded from the picker on the reasoning that a sum of children typed in
// different units has no entry unit to honour. True, but it left the one figure you
// most often want re-expressed — a stuff sack's total — pinned to the list's unit
// with no way to move it. So `entryUnit` on a parent now means the unit its TOTAL
// reads in, and the row carries the same picker every other row has.
//
// Driven through the real <ItemRow> and the real reducer, because the whole change is
// in what the row RENDERS: which of two computeds fills the weight cell, which branch
// of the template draws the unit, and whether the pick survives as far as the item.
import { beforeEach, describe, expect, it } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { mount } from "@vue/test-utils";
import ItemRow, { CHILDREN_BY_PARENT, PEOPLE_CTX } from "~/components/ItemRow.vue";
import type { Item, ListSnapshot, Person } from "~~/shared/types";
import { blankList } from "./helpers/list";
import type { ItemPatch } from "~~/shared/ops";
import { applyOps } from "~~/shared/ops";

registerEndpoint("/api/catalog/search", () => ({ results: [] }));
registerEndpoint("/api/catalog/use", { method: "POST", handler: () => ({ ok: true }) });

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(false),
  vaultKnown: ref(true),
  vaultFetch: <T,>() => Promise.resolve({} as T),
}));

const snapshot = ref<ListSnapshot>(blankList());
mockNuxtImport("useGearList", () => () => ({
  pendingBlankId: ref<string | null>(null),
  updateItem: (id: string, patch: ItemPatch) => {
    snapshot.value = applyOps(snapshot.value, [{ t: "updateItem", id, patch }]) as ListSnapshot;
  },
  setItemWeight: () => {},
  removeItem: () => {},
  duplicateItem: () => "",
  moveItem: () => {},
  discardEmpty: () => {},
  addBlankItemAfter: () => "",
  addChild: () => "",
  nestItem: () => {},
  unnest: () => {},
  saveItemToVault: () => Promise.resolve(),
  vaultAuto: ref(false),
  vaultDeclined: ref(new Set<string>()),
}));

const item = (over: Partial<Item> & { id: string }): Item => ({
  folderId: "f1",
  parentId: null,
  name: "",
  unitWeightMg: 0,
  qty: 1,
  classification: null,
  sortOrder: 0,
  ...over,
});

// a stuff sack holding a power bank and a headlamp — 268 g between them
const GROUP = item({ id: "sack", name: "Electronics stuff sack" });
const KIDS = [
  item({ id: "bank", name: "Power bank", parentId: "sack", unitWeightMg: 160_000, entryUnit: "g", sortOrder: 0 }),
  item({ id: "lamp", name: "Headlamp", parentId: "sack", unitWeightMg: 108_000, sortOrder: 1 }),
];

/** Mount `row` with `children` hanging off it, exactly as GearEditor provides them. */
function mountRow(row: Item, children: Item[] = []) {
  snapshot.value = { ...blankList(), items: [{ ...row }, ...children] } as ListSnapshot;
  return mount(ItemRow, {
    props: {
      get list() {
        return snapshot.value;
      },
      // read off the reactive snapshot so a pick re-renders the row
      get item() {
        return snapshot.value.items[0]!;
      },
    },
    global: {
      provide: {
        [CHILDREN_BY_PARENT as symbol]: ref(new Map([[row.id, children]])),
        [PEOPLE_CTX as symbol]: { sorted: ref<Person[]>([]), slotById: ref(new Map<string, number>()) },
      },
    },
    attachTo: document.body,
  });
}

const weightField = (w: ReturnType<typeof mountRow>) =>
  (w.find('input[aria-label="Weight"]').element as HTMLInputElement).value;
// scoped to the weight cell — .item__unit is also the qty field's "×"
const unitLabel = (w: ReturnType<typeof mountRow>) => w.find(".item__unitwrap .item__unit").text();

/** Open the row's unit picker and choose `unit` from it. */
async function pickUnit(w: ReturnType<typeof mountRow>, unit: string) {
  await w.find(".item__unitwrap .optmenu__btn").trigger("click");
  const row = w.findAll(".optmenu__item").find((b) => b.text() === unit);
  if (!row) throw new Error(`no "${unit}" in the unit menu`);
  await row.trigger("click");
}

describe("a group row's weight unit", () => {
  beforeEach(() => {
    snapshot.value = blankList();
  });

  it("starts in the list's unit and totals its children", () => {
    const w = mountRow(GROUP, KIDS);
    expect(weightField(w)).toBe("268"); // 160 g + 108 g
    expect(unitLabel(w)).toBe("g");
    w.unmount();
  });

  it("carries the same picker every other row has", () => {
    const w = mountRow(GROUP, KIDS);
    // the real control, not the ghost chevron that only holds the column open
    expect(w.find(".item__unitwrap .optmenu__btn").exists()).toBe(true);
    expect(w.find(".item__unitchev--ghost").exists()).toBe(false);
    w.unmount();
  });

  it("re-expresses the total in the picked unit — and remembers it", async () => {
    const w = mountRow(GROUP, KIDS);
    await pickUnit(w, "oz");
    expect(snapshot.value.items[0]!.entryUnit).toBe("oz");
    expect(unitLabel(w)).toBe("oz");
    expect(weightField(w)).toBe("9.5"); // the same 268 g, in ounces
    w.unmount();
  });

  it("re-expresses nothing else: the children keep their own units", async () => {
    const w = mountRow(GROUP, KIDS);
    await pickUnit(w, "lb");
    expect(weightField(w)).toBe("0.59");
    // the group's pick is the group's — a child that reads in grams still does
    expect(snapshot.value.items[1]!.entryUnit).toBe("g");
    w.unmount();
  });

  it("leaves the group's own weight alone — the pick is display, not a conversion", async () => {
    const w = mountRow(GROUP, KIDS);
    await pickUnit(w, "oz");
    expect(snapshot.value.items[0]!.unitWeightMg).toBe(0);
    expect(snapshot.value.items[1]!.unitWeightMg).toBe(160_000);
    w.unmount();
  });

  // Water is the one row left out: its weight is derived from a volume, so there is
  // no unit to pick — it keeps the plain label and the chevron's empty slot.
  it("is still withheld from a water row", () => {
    const w = mountRow(item({ id: "w1", name: "Water", unitWeightMg: 1_000_000 }));
    expect(w.find(".item__unitwrap .optmenu__btn").exists()).toBe(false);
    expect(w.find(".item__unitchev--ghost").exists()).toBe(true);
    w.unmount();
  });
});
