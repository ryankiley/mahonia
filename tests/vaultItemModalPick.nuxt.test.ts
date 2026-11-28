// My Gear's add dialog fills its form from a pick in the catalog search above it. A second
// pick replaces what the first one filled, and that includes a weight the second has none
// of: a size of your own, typed onto a catalog product, has no cited weight, and the last
// pick's figure left in the field would be saved on it as if it were this size's.
import { afterEach, describe, expect, it } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { h, nextTick } from "vue";
import VaultItemModal from "~/components/VaultItemModal.vue";
import type { NameCommit } from "~/composables/useCatalogSearch";
import { vaultRow } from "./helpers/vault";

enableAutoUnmount(afterEach);

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  vaultKnown: ref(true),
  vaultFetch: () => Promise.resolve({ ok: true }),
}));

function openAdding() {
  let pick!: (c: NameCommit) => void;
  const w = mount(VaultItemModal, {
    props: { entry: vaultRow({ id: 0, normKey: "", name: "", weightMg: 0 }), adding: true, unit: "g" },
    slots: {
      search: (p: { pick: (c: NameCommit) => void }) => {
        pick = p.pick;
        return h("span");
      },
    },
    attachTo: document.body,
  });
  const field = (label: string) =>
    w.findAll("label.dlg__field").find((l) => l.text().startsWith(label))!.get("input").element as HTMLInputElement;
  return { pick: (c: NameCommit) => pick(c), field };
}

const QUILT = { name: "Revelation", brand: "Enlightened Equipment", commonName: "Quilt" };

describe("a pick in the add dialog", () => {
  it("fills the weight from a catalog version", async () => {
    const d = openAdding();
    d.pick({ ...QUILT, variant: "20F, Regular", weightMg: 560_000, catalogItemId: 7 });
    await nextTick();
    expect(d.field("Weight").value).toBe("560 g");
  });

  it("clears the last pick's weight when a size of your own replaces it", async () => {
    const d = openAdding();
    d.pick({ ...QUILT, variant: "20F, Regular", weightMg: 560_000, catalogItemId: 7 });
    await nextTick();
    d.pick({ ...QUILT, variant: "20F, XXL", own: true });
    await nextTick();
    expect(d.field("Size or version").value).toBe("20F, XXL");
    expect(d.field("Weight").value).toBe("");
  });

  it("keeps a weight you typed yourself", async () => {
    const d = openAdding();
    const weight = d.field("Weight");
    weight.value = "540";
    weight.dispatchEvent(new Event("input"));
    await nextTick();
    d.pick({ ...QUILT, variant: "20F, XXL", own: true });
    await nextTick();
    expect(d.field("Weight").value).toBe("540");
  });
});
