// A piece whose name opens with its brand ("Goldwin 0 3L Jacket" under Goldwin) drew no
// brand at all, so its whole name wore the name's ink beside neighbours whose brand was
// grey. The brand is drawn once either way: from the name's own opening words there.
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import VaultPane from "~/components/VaultPane.vue";

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  vaultFetch: async () => ({
    items: [
      { id: 1, brand: "Goldwin", name: "MT Gany Light Tapered Pants", commonName: "Hiking pants", weightMg: 171_000, normKey: "goldwin|mt gany light tapered pants|" },
      { id: 2, brand: "Goldwin", name: "Goldwin 0 3L Jacket", commonName: "Rain jacket", weightMg: 420_000, normKey: "goldwin|goldwin 0 3l jacket|" },
    ],
  }),
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

describe("a brand in the My Gear pane", () => {
  it("is drawn once, in its own element, whether or not the name repeats it", async () => {
    const pane = mount(VaultPane, { props: { width: 368 }, attachTo: document.body });
    await flushPromises();
    await nextTick();
    // the brand's element, then the name's: the gap between them is the stylesheet's
    const rows = pane.findAll(".gear__name").map((n) => [n.find(".gear__brand").text(), n.find(".gear__brand + span").text()]);
    expect(rows).toContainEqual(["Goldwin", "MT Gany Light Tapered Pants"]);
    expect(rows).toContainEqual(["Goldwin", "0 3L Jacket"]);
    for (const name of pane.findAll(".gear__name")) expect(name.attributes("title")).not.toContain("Goldwin Goldwin");
  });
});
