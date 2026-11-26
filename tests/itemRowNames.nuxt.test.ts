// Every control on a row says WHICH row. The stepper and the grip always did ("One more
// X-Mid 2", "Reorder X-Mid 2"); the rest read "Remove item", "Consumable" and "More
// actions" once per row, so a list of twenty gave a screen reader twenty of each.
// Mounted, because each name is a binding in a template. What stays as it was is
// asserted too: the menus' own names are the bare word, the way the tooltips are.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import FolderSection from "~/components/FolderSection.vue";
import { useItemMenu } from "~/composables/useItemMenu";
import { mountRowOver } from "./helpers/itemRow";
import type { Item, ListSnapshot } from "~~/shared/types";
import { blankList, folder, item } from "./helpers/list";
import { gearListStub, quietVaultAccess } from "./helpers/gearList";

registerEndpoint("/api/catalog/search", () => ({ results: [] }));

mockNuxtImport("useVaultAccess", () => () => quietVaultAccess());

const snapshot = ref<ListSnapshot>(blankList());
mockNuxtImport("useGearList", () => () => gearListStub({ snapshot }));

enableAutoUnmount(afterEach);

const mountRow = (row: Item) => mountRowOver(snapshot, [{ ...row }]);
type W = ReturnType<typeof mountRow>;
const name = (w: W, selector: string) => w.get(selector).attributes("aria-label");
const names = (w: W) => ({
  unit: name(w, ".item__unitwrap .optmenu__btn"),
  cls: name(w, ".item__clsbtn"),
  nesting: name(w, ".item__nest-btn"),
  duplicate: name(w, ".item__dup"),
  remove: name(w, ".item__del"),
  more: name(w, ".item__morebtn"),
});

describe("a row's controls name the row", () => {
  beforeEach(() => useItemMenu().close());

  it("by the item's name", () => {
    const w = mountRow(item({ id: "tent", name: "X-Mid 2", unitWeightMg: 887_000 }));
    expect(names(w)).toEqual({
      unit: "Weight unit for X-Mid 2",
      cls: "Base weight for X-Mid 2",
      nesting: "Group for X-Mid 2",
      duplicate: "Duplicate X-Mid 2",
      remove: "Remove X-Mid 2",
      more: "More actions for X-Mid 2",
    });
  });

  it("as an item when it has no name yet", () => {
    const w = mountRow(item({ id: "blank", unitWeightMg: 100_000 }));
    expect(names(w)).toEqual({
      unit: "Weight unit for this item",
      cls: "Base weight for item",
      nesting: "Group for item",
      duplicate: "Duplicate item",
      remove: "Remove item",
      more: "More actions for item",
    });
  });

  it("with the class opening the name on the class mark, and the count on a part-worn row", () => {
    const food = mountRow(item({ id: "mix", name: "Trail mix", unitWeightMg: 200_000, classification: "consumable" }));
    expect(name(food, ".item__clsbtn")).toBe("Consumable for Trail mix");
    const shirt = mountRow(item({ id: "shirt", name: "Sun hoody", unitWeightMg: 150_000, classification: "worn" }));
    expect(name(shirt, ".item__clsbtn")).toBe("Worn for Sun hoody");
    const socks = mountRow(item({ id: "socks", name: "Socks", unitWeightMg: 50_000, qty: 3, wornQty: 1 }));
    expect(name(socks, ".item__clsbtn")).toBe("1 of 3 worn for Socks");
  });

  it("while the menus they open keep their own names", async () => {
    const w = mountRow(item({ id: "tent", name: "X-Mid 2", unitWeightMg: 887_000 }));
    await w.get(".item__nest-btn").trigger("click");
    expect(w.get('.item__nest [role="menu"]').attributes("aria-label")).toBe("Group");
    await w.get(".item__morebtn").trigger("click");
    expect(w.get('.item__more [role="menu"]').attributes("aria-label")).toBe("Item actions");
    // the menu row is visible text, read with the menu's trigger behind it
    expect(w.get(".item__more").text()).toContain("Remove item");
  });
});

describe("a folder's remove button", () => {
  const remove = (f: ReturnType<typeof folder>) =>
    mount(FolderSection, {
      props: { list: blankList({ folders: [f] }), folder: f, items: [] },
      global: { stubs: { FolderRows: true } },
    }).get(".folder__actions button");

  it("names the folder, as its grip and chevron do, under the same tooltip", () => {
    const button = remove(folder({ name: "Shelter" }));
    expect(button.attributes("aria-label")).toBe("Remove Shelter");
    expect(button.attributes("title")).toBe("Remove folder");
  });

  it("falls back to the word on a folder with no name", () => {
    expect(remove(folder({ name: "" })).attributes("aria-label")).toBe("Remove folder");
  });
});
