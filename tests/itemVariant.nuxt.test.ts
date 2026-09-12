// @vitest-environment nuxt
//
// A row's variant, shown only where it tells the reader something, and always on the
// sub-line under the name, never on the name line. Three faces render the answer
// shared/variantShown gives (pinned as plain TS in variantShown.test.ts):
//   • <ItemName>, the name on the checklist and share rows, is brand + product and
//     nothing else;
//   • the share view's row puts the variant on its sub-line only when its list says
//     so, and passes the answer down to nested rows;
//   • the editor's row keeps the variant OUT of the name field, gives it a field of its
//     own in the edit sub-line beside the gear type (a pick fills it, a person can type
//     one), and puts it on the checklist face's sub-line only where the list holds the
//     same product in another variant.
// Mounted rather than reasoned about, because each is a binding in a template, and a
// template binding that goes missing fails no type check.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { ref, type Ref } from "vue";
import ItemName from "~/components/ItemName.vue";
import ItemRow from "~/components/ItemRow.vue";
import ReadonlyItemRow from "~/components/ReadonlyItemRow.vue";
import { useEditorMode } from "~/composables/useEditorMode";
import { rowProvides } from "./helpers/itemRow";
import type { Item, ListSnapshot } from "~~/shared/types";
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

enableAutoUnmount(afterEach);

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
// a catalog pick as it lands on a row: linked, sized, with the catalog's gear type
const longQuilt = (over: Partial<Item> = {}) =>
  item({
    id: "q1",
    brand: "Enlightened Equipment",
    name: "Revelation",
    variant: "Long",
    commonName: "Quilt",
    catalogItemId: 7,
    unitWeightMg: 560_000,
    ...over,
  });

describe("<ItemName>", () => {
  const mountName = (props: { item: Item }) => mount(ItemName, { props });

  it("shows brand and product, and nothing else", () => {
    const w = mountName({ item: longQuilt() });
    expect(w.text()).toBe("Enlightened Equipment Revelation");
  });

  it("shows just the name on a renamed row", () => {
    // a rename drops the catalog's brand and variant on the way to the user's own name
    // (ItemRow.onNameCommit)
    const w = mountName({ item: longQuilt({ name: "My old quilt", brand: "", variant: "", nameOverridden: true }) });
    expect(w.text()).toBe("My old quilt");
  });
});

describe("the share view's row", () => {
  function mountRo(row: Item, children: Item[] = [], shown: ReadonlySet<string> = new Set()) {
    const list = { ...blankList(), items: [row, ...children] } as ListSnapshot;
    return mount(ReadonlyItemRow, {
      props: { list, item: row, childrenByParent: new Map([[row.id, children]]), variantShownIds: shown },
    });
  }

  it("shows brand and product on the name line, and the gear type alone under it, when the list holds one of the product", () => {
    const w = mountRo(longQuilt());
    expect(w.find(".item__ronametext").text()).toBe("Enlightened Equipment Revelation");
    expect(w.find(".item__rosub").text()).toBe("Quilt");
    expect(w.find(".item__rovariant").exists()).toBe(false);
  });

  it("puts the variant on the sub-line beside the gear type when the list says this row's is the one telling it apart", () => {
    const w = mountRo(longQuilt(), [], new Set(["q1"]));
    expect(w.find(".item__ronametext").text()).toBe("Enlightened Equipment Revelation");
    expect(w.find(".item__rovariant").text()).toBe("· Long");
    expect(w.find(".item__rosub").text()).toBe("Quilt · Long");
  });

  it("opens the sub-line for a variant alone, and dots the note after it", () => {
    const w = mountRo(longQuilt({ commonName: undefined, description: "the summer one" }), [], new Set(["q1"]));
    expect(w.find(".item__rosub").text()).toBe("Long · the summer one");
  });

  // a typed variant on a hand-named row is as much the row's as a picked one
  it("shows a typed variant on a renamed row when the list names it", () => {
    const w = mountRo(longQuilt({ name: "Summer quilt", brand: "", nameOverridden: true }), [], new Set(["q1"]));
    expect(w.find(".item__ronametext").text()).toBe("Summer quilt");
    expect(w.find(".item__rovariant").text()).toBe("· Long");
  });

  it("spells a letter size out", () => {
    const w = mountRo(longQuilt({ variant: "Men's M" }), [], new Set(["q1"]));
    expect(w.find(".item__rovariant").text()).toBe("· Men's Medium");
  });

  it("hands the set down to a nested row", () => {
    const group = item({ id: "g", name: "Sleep kit" });
    const child = longQuilt({ parentId: "g" });
    const w = mountRo(group, [child], new Set(["q1"]));
    // the parent's own sub-line carries no variant; the child's, one level down, does.
    // Scoped to the parent's row element: a parent renders its children as more of the
    // same component, so an unscoped find would answer for the child.
    expect(w.find(".item-row").find(".item__rovariant").exists()).toBe(false);
    expect(w.find(".ro-nest .item__rovariant").text()).toBe("· Long");
  });
});

describe("the editor's row", () => {
  function mountRow(row: Item, shown: ReadonlySet<string> | Ref<ReadonlySet<string>> = new Set()) {
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
      global: { provide: rowProvides(new Map(), undefined, shown) },
      attachTo: document.body,
    });
  }

  beforeEach(() => {
    // both faces in the DOM: which one SHOWS is CSS off the body's data-mode, and
    // the checklist face only mounts once packing has been entered (useEditorMode)
    const em = useEditorMode();
    em.mode.value = "edit";
    em.everEdit.value = true;
    em.everPacked.value = true;
  });

  it("keeps the variant out of the name field", () => {
    const w = mountRow(longQuilt());
    const field = w.find(".ac__input").element as HTMLInputElement;
    expect(field.value).toBe("Enlightened Equipment Revelation");
  });

  it("names the variant in the sub-line, in a field beside the gear type", () => {
    const w = mountRow(longQuilt());
    const line = w.find(".item__gtype-line");
    expect((line.find(".item__gtype-input").element as HTMLInputElement).value).toBe("Quilt");
    expect(line.find(".item__gtype-dot").exists()).toBe(true);
    expect((line.find(".item__variant-input").element as HTMLInputElement).value).toBe("Long");
  });

  it("opens the sub-line for a variant alone, without the gear type's dot", () => {
    const w = mountRow(longQuilt({ commonName: undefined }));
    expect(w.find(".item__gtype-input").exists()).toBe(false);
    expect(w.find(".item__gtype-dot").exists()).toBe(false);
    expect((w.find(".item__variant-input").element as HTMLInputElement).value).toBe("Long");
  });

  it("opens an empty variant field with the gear type's while the name is being edited, on a leaf only", async () => {
    const leaf = mountRow(item({ id: "t", name: "Tarp" }));
    expect(leaf.find(".item__variant-input").exists()).toBe(false);
    await leaf.find(".item__namebox").trigger("focusin");
    expect(leaf.find(".item__gtype-input").exists()).toBe(true);
    expect(leaf.find(".item__variant-input").exists()).toBe(true);
    // the person's words, not the catalog's: "variant" is trade vocabulary
    expect(leaf.find(".item__variant-input").attributes("placeholder")).toBe("Size or version");
    expect(leaf.find(".item__variant-input").attributes("aria-label")).toBe("Size or version");
    leaf.unmount();

    snapshot.value = { ...blankList(), items: [item({ id: "g", name: "Cook kit" }), item({ id: "c", name: "Pot", parentId: "g" })] } as ListSnapshot;
    const group = mount(ItemRow, {
      props: {
        get list() {
          return snapshot.value;
        },
        get item() {
          return snapshot.value.items[0]!;
        },
      },
      global: { provide: rowProvides(new Map([["g", [snapshot.value.items[1]!]]])) },
      attachTo: document.body,
    });
    await group.find(".item__namebox").trigger("focusin");
    expect(group.find(".item__variant-input").exists()).toBe(false);
  });

  // typing one: stored through the reducer (the stub's updateItem runs the real one),
  // and the name marked the person's so live-resolve keeps its hands off the triple
  it("stores a typed variant and marks the name the person's", async () => {
    const w = mountRow(item({ id: "t", name: "Tarp", commonName: "Shelter" }));
    await w.find(".item__namebox").trigger("focusin"); // opens the empty field
    const field = w.find<HTMLInputElement>(".item__variant-input");
    field.element.value = "  8 x 10  ";
    await field.trigger("change");
    expect(snapshot.value.items[0]).toMatchObject({ variant: "8 x 10", nameOverridden: true });
    expect((w.find(".item__variant-input").element as HTMLInputElement).value).toBe("8 x 10");
  });

  it("clears a variant typed away, and keeps the row's name", async () => {
    const w = mountRow(longQuilt());
    const field = w.find<HTMLInputElement>(".item__variant-input");
    field.element.value = "";
    await field.trigger("change");
    expect(snapshot.value.items[0]!.variant).toBeUndefined();
    expect(snapshot.value.items[0]).toMatchObject({ name: "Revelation", brand: "Enlightened Equipment" });
  });

  // the letter the catalog stores reads as a word on every face, and the field stores
  // the letter until someone types over it
  it("spells a letter size out on every face, and keeps the letter stored", async () => {
    const w = mountRow(longQuilt({ variant: "M" }), new Set(["q1"]));
    expect((w.find(".item__variant-input").element as HTMLInputElement).value).toBe("Medium");
    expect(w.find("label.item--check .item__cvariant").text()).toBe("· Medium");
    expect(snapshot.value.items[0]!.variant).toBe("M");
  });

  it("shows a typed variant on a renamed row's sub-line", () => {
    const w = mountRow(longQuilt({ name: "Summer quilt", brand: "", nameOverridden: true, commonName: undefined }));
    expect((w.find(".item__variant-input").element as HTMLInputElement).value).toBe("Long");
  });

  it("puts the variant on the checklist face's sub-line only where it disambiguates, never on the name line", () => {
    const alone = mountRow(longQuilt());
    expect(alone.find("label.item--check .iname").text()).toBe("Enlightened Equipment Revelation");
    expect(alone.find("label.item--check .item__csub").text()).toBe("Quilt");
    expect(alone.find("label.item--check .item__cvariant").exists()).toBe(false);
    alone.unmount();

    const twin = mountRow(longQuilt(), new Set(["q1"]));
    expect(twin.find("label.item--check .iname").text()).toBe("Enlightened Equipment Revelation");
    expect(twin.find("label.item--check .item__cvariant").text()).toBe("· Long");
    expect(twin.find("label.item--check .item__csub").text()).toBe("Quilt · Long");
    twin.unmount();

    // a variant with no gear type opens the sub-line on its own, without a stray dot
    const bare = mountRow(longQuilt({ commonName: undefined }), new Set(["q1"]));
    expect(bare.find("label.item--check .item__csub").text()).toBe("Long");
  });

  it("shows a typed variant on the checklist face of a renamed row when the list names it", () => {
    const w = mountRow(longQuilt({ name: "Summer quilt", brand: "", nameOverridden: true }), new Set(["q1"]));
    expect(w.find("label.item--check .iname").text()).toBe("Summer quilt");
    expect(w.find("label.item--check .item__cvariant").text()).toBe("· Long");
  });

  // The row is mounted over its own snapshot FIRST (mountRow), and only the answer set
  // moves: this case used to mount over whatever row the previous case left in the
  // shared snapshot and swap it afterwards, which passed only while that leftover
  // happened to be an unrenamed twin — and failed on its own (`-t`) with no row at all.
  it("follows the list: a twin arriving later brings the variant out, and leaving takes it back", async () => {
    const shown = ref<ReadonlySet<string>>(new Set());
    const w = mountRow(longQuilt(), shown);
    expect(w.find("label.item--check .item__cvariant").exists()).toBe(false);
    shown.value = new Set(["q1"]);
    await w.vm.$nextTick();
    expect(w.find("label.item--check .item__cvariant").text()).toBe("· Long");
    shown.value = new Set();
    await w.vm.$nextTick();
    expect(w.find("label.item--check .item__cvariant").exists()).toBe(false);
  });
});
