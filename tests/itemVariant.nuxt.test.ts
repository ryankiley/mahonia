// @vitest-environment nuxt
//
// A row's variant, shown only where it tells the reader something. Three faces render
// the answer shared/variantShown gives (pinned as plain TS in variantShown.test.ts):
//   • <ItemName>, the name on the checklist and share rows, shows the dimmed suffix
//     only when its caller says so;
//   • the share view's row passes its list's answer down, nested rows included;
//   • the editor's row keeps the variant OUT of the name field, puts it in the
//     sub-line beside the gear type, and shows it beside the name on the checklist
//     face only where the list holds the same product in another variant.
// Mounted rather than reasoned about, because each is a binding in a template, and a
// template binding that goes missing fails no type check.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { ref } from "vue";
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
  const mountName = (props: { item: Item; variant?: boolean }) => mount(ItemName, { props });

  it("shows brand and product, and no variant unless told to", () => {
    const w = mountName({ item: longQuilt() });
    expect(w.text()).toBe("Enlightened Equipment Revelation");
    expect(w.find(".iname__variant").exists()).toBe(false);
  });

  it("shows the variant as its dimmed suffix when told to", () => {
    const w = mountName({ item: longQuilt(), variant: true });
    expect(w.find(".iname__variant").text()).toBe("· Long");
    expect(w.text()).toBe("Enlightened Equipment Revelation · Long");
  });

  it("never shows one on a renamed row, told or not", () => {
    // a rename drops the catalog's brand and variant on the way to the user's own name
    // (ItemRow.onNameCommit); a stale one left behind must not resurface
    const w = mountName({ item: longQuilt({ nameOverridden: true }), variant: true });
    expect(w.find(".iname__variant").exists()).toBe(false);
  });
});

describe("the share view's row", () => {
  function mountRo(row: Item, children: Item[] = [], shown: ReadonlySet<string> = new Set()) {
    const list = { ...blankList(), items: [row, ...children] } as ListSnapshot;
    return mount(ReadonlyItemRow, {
      props: { list, item: row, childrenByParent: new Map([[row.id, children]]), variantShownIds: shown },
    });
  }

  it("shows brand and product alone when the list holds one of the product", () => {
    const w = mountRo(longQuilt());
    expect(w.find(".item__ronametext").text()).toContain("Enlightened Equipment Revelation");
    expect(w.find(".iname__variant").exists()).toBe(false);
  });

  it("shows the variant when the list says this row's is the one telling it apart", () => {
    const w = mountRo(longQuilt(), [], new Set(["q1"]));
    expect(w.find(".iname__variant").text()).toBe("· Long");
  });

  it("hands the set down to a nested row", () => {
    const group = item({ id: "g", name: "Sleep kit" });
    const child = longQuilt({ parentId: "g" });
    const w = mountRo(group, [child], new Set(["q1"]));
    // the parent's own name line carries no variant; the child's, one level down, does.
    // Scoped to the parent's row element: a parent renders its children as more of the
    // same component, so an unscoped find would answer for the child.
    expect(w.find(".item-row").find(".iname__variant").exists()).toBe(false);
    expect(w.find(".ro-nest .iname__variant").text()).toBe("· Long");
  });
});

describe("the editor's row", () => {
  function mountRow(row: Item, shown: ReadonlySet<string> = new Set()) {
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

  it("names the variant in the sub-line, beside the gear type", () => {
    const w = mountRow(longQuilt());
    const line = w.find(".item__gtype-line");
    expect((line.find(".item__gtype-input").element as HTMLInputElement).value).toBe("Quilt");
    expect(line.find(".item__variant").text()).toBe("· Long");
  });

  it("opens the sub-line for a variant alone, without the gear type's dot", () => {
    const w = mountRow(longQuilt({ commonName: undefined }));
    expect(w.find(".item__gtype-input").exists()).toBe(false);
    expect(w.find(".item__variant").text()).toBe("Long");
  });

  it("shows nothing in the sub-line for a renamed row's stale variant", () => {
    const w = mountRow(longQuilt({ nameOverridden: true, commonName: undefined }));
    expect(w.find(".item__variant").exists()).toBe(false);
  });

  it("puts the variant beside the name on the checklist face only where it disambiguates", () => {
    const alone = mountRow(longQuilt());
    expect(alone.find("label.item--check .iname").text()).toBe("Enlightened Equipment Revelation");
    expect(alone.find("label.item--check .iname__variant").exists()).toBe(false);
    alone.unmount();

    const twin = mountRow(longQuilt(), new Set(["q1"]));
    expect(twin.find("label.item--check .iname__variant").text()).toBe("· Long");
  });

  it("follows the list: a twin arriving later brings the variant out, and leaving takes it back", async () => {
    const shown = ref<ReadonlySet<string>>(new Set());
    const w = mount(ItemRow, {
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
    snapshot.value = { ...blankList(), items: [longQuilt()] } as ListSnapshot;
    await w.vm.$nextTick();
    expect(w.find("label.item--check .iname__variant").exists()).toBe(false);
    shown.value = new Set(["q1"]);
    await w.vm.$nextTick();
    expect(w.find("label.item--check .iname__variant").text()).toBe("· Long");
    shown.value = new Set();
    await w.vm.$nextTick();
    expect(w.find("label.item--check .iname__variant").exists()).toBe(false);
  });
});
