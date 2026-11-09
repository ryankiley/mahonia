// The panel's search names the other tabs it matched, and following one takes the
// words along. The rule itself (matchesElsewhere) is pinned in vaultView.test.ts; what
// only the panel can get wrong is the hand-off, because it keeps one query per tab:
// a switch that dropped the words would land you on Food searching for nothing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import VaultPane from "~/components/VaultPane.vue";

const GEAR = [
  { id: 1, name: "Duplex", commonName: "Tent", weightMg: 539_000, normKey: "|duplex|" },
  { id: 2, brand: "Clif", name: "Nut Butter Bar", commonName: "Energy bar", kcal: 228, weightMg: 50_000, normKey: "clif|nut butter bar|" },
  { id: 3, brand: "Clif", name: "Bloks", commonName: "Energy chews", kcal: 200, weightMg: 60_000, normKey: "clif|bloks|" },
  // gear that shares the brand word, so a search can match on two tabs at once
  { id: 4, brand: "Clif", name: "Bar bag", commonName: "Stuff sack", weightMg: 20_000, normKey: "clif|bar bag|" },
];

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  vaultFetch: async () => ({ items: GEAR }),
}));
mockNuxtImport("useGearList", () => () => ({
  snapshot: ref({ folders: [], items: [], displayUnit: "g" }),
  addVaultItem: vi.fn(),
  moveItem: vi.fn(),
  vaultGear: ref(new Map()),
  vaultGearAsked: ref(new Set()),
  vaultGearSettled: ref(true),
}));
mockNuxtImport("useItemDnd", () => () => ({ startInsert: vi.fn(), dragId: ref(null) }));

enableAutoUnmount(afterEach);

async function openPane() {
  const wrapper = mount(VaultPane, { props: { width: 368 }, attachTo: document.body });
  await flushPromises();
  await nextTick();
  return wrapper;
}

describe("the panel's search across tabs", () => {
  it("says where else a miss matched, and following it keeps the words", async () => {
    const pane = await openPane();
    await pane.find("input").setValue("bloks");
    const note = pane.find(".vp__note");
    expect(note.text()).toContain("Nothing here matches “bloks”.");
    const go = note.find("button");
    expect(go.text()).toBe("1 on Food");

    await go.trigger("click");
    await nextTick();
    expect(pane.find(".vp__tab.is-active").text()).toBe("Food");
    expect((pane.find("input").element as HTMLInputElement).value).toBe("bloks");
    expect(pane.findAll(".vp__add").map((b) => b.text())).toEqual([expect.stringContaining("Bloks")]);
  });

  it("names the other tab under results too, and says nothing when there is none", async () => {
    const pane = await openPane();
    await pane.find("input").setValue("clif");
    expect(pane.findAll(".vp__add").map((b) => b.text())).toEqual([expect.stringContaining("Bar bag")]);
    expect(pane.find(".vp__note").text()).toBe("Also 2 on Food");

    await pane.find("input").setValue("duplex");
    expect(pane.find(".vp__note").exists()).toBe(false);
  });
});
