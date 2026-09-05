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
import { rowProvides } from "./helpers/itemRow";
import ItemInput from "~/components/ItemInput.vue";
import type { Item, ListSnapshot, Person } from "~~/shared/types";
import type { ItemPatch } from "~~/shared/ops";
import { applyOps } from "~~/shared/ops";
import { blankList } from "./helpers/list";
import { gearListStub } from "./helpers/gearList";

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
    global: { provide: rowProvides(new Map([[row.id, children]])) },
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
    // a weight or calories — either on its own is a number the row contributes, and
    // hiding a number this view cannot also correct is the bug
    for (const carrier of [
      item({ id: "dinners", name: "Dinners", unitWeightMg: 210_000 }),
      item({ id: "dinners", name: "Dinners", kcal: 700, classification: "consumable" }),
    ]) {
      const w = mountRow(carrier, [CHILD]);
      expect(hasQty(w)).toBe(true);
      expect(hasClassMarks(w)).toBe(true);
      w.unmount();
    }
  });

  // The count is NOT a term in the predicate, and deliberately: while it was, the cell's
  // own "one fewer" button could take the cell away at qty 1, stranding the count with no
  // control anywhere to raise it again.
  it("does not let the stepper decide whether the stepper is drawn", () => {
    const w = mountRow(item({ id: "kit", name: "Cook kit", qty: 4 }), [CHILD]);
    expect(hasQty(w)).toBe(false); // a count on a contentless group multiplies zero
    w.unmount();
  });

  // Two rows keep their marks even while bare, because taking them away would strand
  // something: water's mark is fixed and is the only thing stating its class, and an
  // explicitly stored class needs a control or it is set forever (and still exported).
  it("keeps the marks where removing them would strand a value", () => {
    const stored = mountRow(item({ id: "dinners", name: "Dinners", classification: "consumable" }), [CHILD]);
    expect(hasClassMarks(stored)).toBe(true);
    expect(hasQty(stored)).toBe(false); // only the marks are held back, not the count
    stored.unmount();

    const water = mountRow(item({ id: "water", name: "Water" }), [CHILD]);
    expect(hasClassMarks(water)).toBe(true);
    water.unmount();
  });

  // Water's cell is a VOLUME, not a count, and the weight field beside it is read-only
  // on a group — drop it and the row has no editable figure left at all.
  it("keeps a water group's litres field", () => {
    const w = mountRow(item({ id: "water", name: "Water" }), [CHILD]);
    expect(hasLitres(w)).toBe(true);
    w.unmount();
  });
});

// THE NAME BOX IS THE OTHER DOOR ONTO A GROUP'S WEIGHT, and the one the wrap doesn't
// watch. Every branch of onNameCommit can carry a weight — a catalog pick, a vault pick,
// a water volume, a trailing "540 g" on free text — while a group's weight cell is
// read-only and shows its children's total. So the weight would be counted in every
// rollup, printed on no row and editable in no field.
//
// Two separate guards, and they are not redundant: `suggest` takes away the MENU (the
// affordance), and onNameCommit refuses the NUMBER (the invariant). Turning off the menu
// alone left free text and the keyboard water path wide open, which is what these cover.
describe("a group's name box", () => {
  beforeEach(() => {
    snapshot.value = blankList();
  });

  const nameField = (w: ReturnType<typeof mountRow>) => w.find<HTMLInputElement>(".item__namebox input");

  async function renameTo(w: ReturnType<typeof mountRow>, text: string) {
    const field = nameField(w);
    await field.trigger("focus");
    field.element.value = text;
    await field.trigger("input");
    await field.trigger("keydown", { key: "Enter" });
    await nextTick();
  }

  it("takes the name from a trailing weight but not the weight", async () => {
    const w = mountRow(item({ id: "kit", name: "Cook kit" }), [CHILD]);
    await renameTo(w, "Cook kit 540 g");
    expect(snapshot.value.items[0]!.name).toBe("Cook kit");
    expect(snapshot.value.items[0]!.unitWeightMg).toBe(0); // the 540 g is refused
    w.unmount();
  });

  it("refuses the water volume the keyboard can commit with no menu drawn", async () => {
    const w = mountRow(item({ id: "kit", name: "Cook kit" }), [CHILD]);
    await renameTo(w, "Water");
    expect(snapshot.value.items[0]!.unitWeightMg).toBe(0);
    w.unmount();
  });

  it("still takes a trailing weight on a leaf", async () => {
    const w = mountRow(item({ id: "pot", name: "Pot" }));
    await renameTo(w, "Pot 540 g");
    expect(snapshot.value.items[0]!.name).toBe("Pot");
    expect(snapshot.value.items[0]!.unitWeightMg).toBe(540_000);
    w.unmount();
  });

  // ...and the menu itself. Asserting the PROP only tested ItemRow's hand-off — both of
  // ItemInput's suppression points could be deleted with the suite green.
  it("draws no suggestion menu, where a leaf's does", async () => {
    const group = mountRow(item({ id: "kit", name: "Cook kit" }), [CHILD]);
    const gf = nameField(group);
    await gf.trigger("focus");
    gf.element.value = "2 L"; // the water reading needs no request, so no debounce to wait out
    await gf.trigger("input");
    await nextTick();
    expect(group.find(".ac__menu").exists()).toBe(false);
    // and the combobox role goes with it — a collapsed combobox that can never expand
    expect(gf.attributes("role")).toBeUndefined();
    group.unmount();

    const leaf = mountRow(item({ id: "pot", name: "Pot" }));
    const lf = nameField(leaf);
    await lf.trigger("focus");
    lf.element.value = "2 L";
    await lf.trigger("input");
    await nextTick();
    expect(leaf.find(".ac__menu").exists()).toBe(true);
    expect(lf.attributes("role")).toBe("combobox");
    leaf.unmount();
  });
});
