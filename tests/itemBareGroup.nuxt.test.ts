// @vitest-environment nuxt
//
// A GROUP ROW'S PER-UNIT CELLS — the count, the two class marks, and the name box's
// catalog suggestions — and the rows where they stand down.
//
// The rule is one predicate (isBareGroup, shared/weights): a row with children that
// holds nothing of its own. Its weight column shows the group TOTAL, so a "×N" beside
// it multiplies a figure it is already inside; its class describes a line that is zero
// and governs no child (they inherit the FOLDER's default, never their parent's); and a
// catalog pick would stamp a weight onto a cell that is read-only and shows the
// children's sum, which is the state the wrap exists to prevent, arriving through the
// name box instead of through a nest.
//
// The NEGATIVE cases are the point, and they are what the first attempt at this got
// wrong: it hid the cells on every parent and rewrote the stored number to match, which
// silently changed the totals of lists that had arrived carrying one (an import, another
// client, a list nested before the wrap existed). Nothing is rewritten now — a group that
// carries a line keeps its controls, where the number can be seen and corrected. Water
// keeps its cell at all times: that one holds a volume, not a count.
//
// Rendered through the real <ItemRow>, because every assertion here is about which
// branch of the template draws.
import { beforeEach, describe, expect, it } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { mount } from "@vue/test-utils";
import ItemRow, { CHILDREN_BY_PARENT, PEOPLE_CTX } from "~/components/ItemRow.vue";
import ItemInput from "~/components/ItemInput.vue";
import type { Item, ListSnapshot, Person } from "~~/shared/types";
import { blankList } from "./helpers/list";

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
  updateItem: () => {},
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
  vaultGear: ref(new Map()),
  vaultGearAsked: ref(new Set()),
  vaultGearSettled: ref(true),
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

const CHILD = item({ id: "chili", name: "Chili", parentId: "dinners", unitWeightMg: 180_000 });

function mountRow(row: Item, children: Item[] = []) {
  snapshot.value = { ...blankList(), items: [{ ...row }, ...children] } as ListSnapshot;
  return mount(ItemRow, {
    props: {
      get list() {
        return snapshot.value;
      },
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

// SCOPED TO THE ROW ITSELF. A parent renders its children as more <ItemRow>s inside its
// own wrapper, so an unscoped find here would answer for the first CHILD — which carries
// every control under test, and would have made all of this pass for the wrong reason.
const own = (w: ReturnType<typeof mountRow>) => w.find(".item-row");
const hasQty = (w: ReturnType<typeof mountRow>) => own(w).find('input[aria-label="Quantity"]').exists();
const hasLitres = (w: ReturnType<typeof mountRow>) => own(w).find('input[aria-label="Litres of water"]').exists();
const hasClassMarks = (w: ReturnType<typeof mountRow>) => own(w).find(".item__classcell").exists();
const suggests = (w: ReturnType<typeof mountRow>) => w.findComponent(ItemInput).props("suggest");

describe("the cells a bare group stands down", () => {
  beforeEach(() => {
    snapshot.value = blankList();
  });

  it("keeps all of them on a leaf", () => {
    const w = mountRow(item({ id: "chili", name: "Chili", unitWeightMg: 180_000 }));
    expect(hasQty(w)).toBe(true);
    expect(hasClassMarks(w)).toBe(true);
    expect(suggests(w)).toBe(true);
    w.unmount();
  });

  it("drops the count and the class marks on a group holding nothing", () => {
    const w = mountRow(item({ id: "dinners", name: "Dinners" }), [CHILD]);
    expect(hasQty(w)).toBe(false);
    expect(hasClassMarks(w)).toBe(false);
    // ...and the weight cell still shows the group's total, read-only as before
    expect((own(w).find('input[aria-label="Weight"]').element as HTMLInputElement).value).toBe("180");
    w.unmount();
  });

  // The name box is a separate rule from the two above — a pick would stamp a weight,
  // so it is off for EVERY group, bare or not.
  it("offers no catalog suggestions while naming any group", () => {
    for (const group of [
      item({ id: "dinners", name: "Dinners" }),
      item({ id: "dinners", name: "Poles", unitWeightMg: 210_000 }),
    ]) {
      const w = mountRow(group, [CHILD]);
      expect(suggests(w)).toBe(false);
      w.unmount();
    }
  });

  it("keeps the count and the marks on a group that carries a line of its own", () => {
    // a weight, calories, or a real count — each on its own is a number the row
    // contributes, and hiding a number this view cannot also correct is the bug
    for (const carrier of [
      item({ id: "dinners", name: "Dinners", unitWeightMg: 210_000 }),
      item({ id: "dinners", name: "Dinners", kcal: 700, classification: "consumable" }),
      item({ id: "dinners", name: "Dinners", qty: 4 }),
    ]) {
      const w = mountRow(carrier, [CHILD]);
      expect(hasQty(w)).toBe(true);
      expect(hasClassMarks(w)).toBe(true);
      w.unmount();
    }
  });

  // Water's cell is a VOLUME, not a count, and the weight field beside it is read-only
  // on a group — drop it and the row has no editable figure left at all.
  it("keeps a water group's litres field", () => {
    const w = mountRow(item({ id: "water", name: "Water" }), [CHILD]);
    expect(hasLitres(w)).toBe(true);
    expect(hasQty(w)).toBe(false); // water never had a count field to begin with
    w.unmount();
  });
});
