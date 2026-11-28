// The My Gear pane printed "10g": the space before the unit was written in the template,
// at the head of an element, where Vue's whitespace condensing drops it. The gap is a
// margin on the unit now, the page row's own 0.25ch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import VaultPane from "~/components/VaultPane.vue";

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  vaultFetch: async () => ({ items: [{ id: 1, name: "Duplex", commonName: "Tent", weightMg: 10_000, normKey: "|duplex|" }] }),
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

describe("a weight in the My Gear pane", () => {
  it("keeps its unit in an element of its own, for the stylesheet to set off from the figure", async () => {
    const pane = mount(VaultPane, { props: { width: 368 }, attachTo: document.body });
    await flushPromises();
    await nextTick();
    const weight = pane.get(".vp__w");
    expect(weight.element.firstChild?.textContent).toBe("10");
    expect(weight.get(".vp__unit").text()).toBe("g");
  });
});
