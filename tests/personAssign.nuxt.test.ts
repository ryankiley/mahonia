// @vitest-environment nuxt
//
// Assigning a row to a person THROUGH the row's own "Carried by" control — and the
// data-person attribute the CSS filter matches on. Drives the real <ItemRow>: the
// pick dispatches through the row's handler, the patch is applied by the real
// reducer, and the assertions read the rendered row (and its attribute) back.
//
// Why the Nuxt environment: the thing under test is not the reducer (ops.test.ts /
// people.test.ts cover that as plain TS) — it is the mounted row's contract with
// the CSS filter: that the wrap carries the right slot, that a nested row inherits
// its parent's through the prop the parent passes, and that the picker's entries
// write the state the row then re-renders from.
import { describe, expect, it } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { mount } from "@vue/test-utils";
import ItemRow from "~/components/ItemRow.vue";
import type { Item, ListSnapshot, Person } from "~~/shared/types";
import { blankList } from "./helpers/list";
import type { ItemPatch } from "~~/shared/ops";
import { applyOps } from "~~/shared/ops";

registerEndpoint("/api/catalog/search", () => ({ results: [] }));

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  vaultKnown: ref(true),
  vaultFetch: () => Promise.resolve({ results: [] }),
}));

// The list under test, as the editor holds it — a reactive snapshot the stub
// controller mutates through the REAL reducer, so what the row re-renders from is
// the state the app would actually have.
const snapshot = ref<ListSnapshot>(blankList());
mockNuxtImport("useGearList", () => () => ({
  pendingBlankId: ref<string | null>(null),
  updateItem: (id: string, patch: ItemPatch) => {
    snapshot.value = applyOps(snapshot.value, [{ t: "updateItem", id, patch }]) as ListSnapshot;
  },
  setItemWeight: () => {},
  removeItem: () => {},
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

const sam: Person = { id: "sam", name: "Sam", colorKey: "shelter", sortOrder: 0 };
const alex: Person = { id: "alex", name: "Alex", colorKey: "sleep", sortOrder: 1 };

const item = (over: Partial<Item> = {}): Item => ({
  id: "i1",
  folderId: "f1",
  name: "Bear Can",
  unitWeightMg: 1000,
  qty: 1,
  classification: null,
  sortOrder: 0,
  ...over,
});

function mountRow(items: Item[], children = new Map<string, Item[]>()) {
  snapshot.value = blankList({ people: [sam, alex], items });
  return mount(ItemRow, {
    props: {
      get list() {
        return snapshot.value;
      },
      get item() {
        return snapshot.value.items[0]!;
      },
      childrenByParent: children,
    },
    attachTo: document.body,
  });
}

describe("carried by — the row's picker + the filter attribute", () => {
  it("stamps the wrap with the effective slot, 'u' when unclaimed", async () => {
    const w = mountRow([item()]);
    expect(w.get(".item-wrap").attributes("data-person")).toBe("u");
    w.unmount();
  });

  it("picking a person dispatches through the reducer and re-stamps the wrap", async () => {
    const w = mountRow([item()]);
    await w.get(".item__person-btn").trigger("click");
    const picks = w.findAll(".item__personpick");
    // people in display order, then the clear entry — one table drives both seats
    expect(picks.map((p) => p.text())).toEqual(["Sam", "Alex", "Unassigned"]);
    await picks[1]!.trigger("click");
    expect(snapshot.value.items[0]!.personId).toBe("alex");
    expect(w.get(".item-wrap").attributes("data-person")).toBe("1");
    // the trigger now wears the carrier's own dot in place of the User glyph
    // (colour lives in a .swatch, chrome stays ink). No .item__mark ground: that
    // atom's pill is always the full --icon-btn box, which can't sit on the
    // column this cluster's right-aligned glyphs share — see ItemRow's style.
    expect(w.get(".item__person-btn").find(".swatch").exists()).toBe(true);
    expect(w.get(".item__person-btn").classes()).not.toContain("item__mark");
    w.unmount();
  });

  it("'Unassigned' hands the row back", async () => {
    const w = mountRow([item({ personId: "sam" })]);
    expect(w.get(".item-wrap").attributes("data-person")).toBe("0");
    await w.get(".item__person-btn").trigger("click");
    const clear = w.findAll(".item__personpick").at(-1)!;
    expect(clear.text()).toBe("Unassigned");
    await clear.trigger("click");
    expect(snapshot.value.items[0]!.personId).toBeUndefined();
    expect(w.get(".item-wrap").attributes("data-person")).toBe("u");
    w.unmount();
  });

  it("a nested row inherits its parent's slot through the prop, until it claims its own", async () => {
    const kit = item({ id: "kit", name: "Cook Kit", personId: "alex" });
    const pot = item({ id: "pot", name: "Pot", parentId: "kit", folderId: "f1", sortOrder: 1 });
    const w = mountRow([kit, pot], new Map([["kit", [pot]]]));
    const wraps = w.findAll(".item-wrap");
    expect(wraps).toHaveLength(2); // the parent renders its child inside its own wrap
    expect(wraps[0]!.attributes("data-person")).toBe("1"); // Alex's kit…
    expect(wraps[1]!.attributes("data-person")).toBe("1"); // …and the pot follows it
    // the child claims itself for Sam — its slot flips, the parent's doesn't
    snapshot.value = applyOps(snapshot.value, [
      { t: "updateItem", id: "pot", patch: { personId: "sam" } },
    ]) as ListSnapshot;
    await w.vm.$nextTick();
    expect(w.findAll(".item-wrap")[1]!.attributes("data-person")).toBe("0");
    expect(w.findAll(".item-wrap")[0]!.attributes("data-person")).toBe("1");
    // a nested row's clear entry says what clearing MEANS one level down
    await w.findAll(".item__person-btn")[1]!.trigger("click");
    expect(w.findAll(".item__personpick").at(-1)!.text()).toBe("Whoever carries the group");
    w.unmount();
  });

  it("under a group nobody carries, the clear entry is plain 'Unassigned'", async () => {
    // "Whoever carries the group" is only true when the group HAS someone. Under an
    // unclaimed group, following it is being unassigned, and the group phrasing
    // would name a carrier that isn't there.
    const kit = item({ id: "kit", name: "Cook Kit" }); // no personId — nobody's
    const pot = item({ id: "pot", name: "Pot", parentId: "kit", folderId: "f1", sortOrder: 1 });
    const w = mountRow([kit, pot], new Map([["kit", [pot]]]));
    expect(w.findAll(".item-wrap")[1]!.attributes("data-person")).toBe("u");
    await w.findAll(".item__person-btn")[1]!.trigger("click");
    expect(w.findAll(".item__personpick").at(-1)!.text()).toBe("Unassigned");

    // …and it becomes the group phrasing the moment the group is claimed
    snapshot.value = applyOps(snapshot.value, [
      { t: "updateItem", id: "kit", patch: { personId: "sam" } },
    ]) as ListSnapshot;
    await w.vm.$nextTick();
    expect(w.findAll(".item__personpick").at(-1)!.text()).toBe("Whoever carries the group");
    w.unmount();
  });

  it("a peopleless list renders no picker at all", () => {
    snapshot.value = blankList({ items: [item()] });
    const w = mount(ItemRow, {
      props: {
        get list() {
          return snapshot.value;
        },
        get item() {
          return snapshot.value.items[0]!;
        },
        childrenByParent: new Map<string, Item[]>(),
      },
    });
    expect(w.find(".item__person-btn").exists()).toBe(false);
    w.unmount();
  });

  it("the checklist face tags the row's own claim", async () => {
    // Mount the checklist face by setting the latch DIRECTLY. The singleton's own
    // mode→latch watcher was created inside the first mounted row's setup scope,
    // so it died with that row's unmount — flipping `mode` here would reach nobody.
    const em = useEditorMode();
    em.mode.value = "pack";
    em.everPacked.value = true;
    const w = mountRow([item({ personId: "sam" })]);
    await w.vm.$nextTick();
    const tag = w.get(".item__carrier");
    expect(tag.text()).toContain("Sam");
    em.mode.value = "edit";
    w.unmount();
  });
});
