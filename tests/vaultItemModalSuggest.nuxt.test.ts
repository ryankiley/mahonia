// My Gear's edit dialog suggests under Brand and Gear type: your own labels first, then
// the catalog's, fetched on the field's first focus. Native datalists, like the editor's
// gear types, so typing filters them and free text still goes in as typed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import VaultItemModal from "~/components/VaultItemModal.vue";
import type { VaultEntry } from "~~/shared/vault";

enableAutoUnmount(afterEach);

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  vaultKnown: ref(true),
  vaultFetch: () => Promise.resolve({ ok: true }),
}));
const fetchBrands = vi.fn(() => ["Durston", "Patagonia", "zpacks"]);
const fetchTypes = vi.fn(() => ["Quilt", "Tent"]);
registerEndpoint("/api/catalog/brands", () => fetchBrands());
registerEndpoint("/api/catalog/types", () => fetchTypes());

const entry: VaultEntry = {
  id: 1,
  normKey: "duplex",
  name: "Duplex",
  weightMg: 539_000,
  timesSeen: 1,
  lastUsedAt: "2026-09-12T00:00:00Z",
  createdAt: "2026-09-12T00:00:00Z",
};

function open() {
  return mount(VaultItemModal, {
    props: { entry, unit: "g", known: { brands: ["Zpacks", "Fjällräven"], types: ["Quilt", "Sleeping pad"] } },
    attachTo: document.body,
  });
}
type W = ReturnType<typeof open>;
const input = (w: W, label: string) => w.findAll("label.dlg__field").find((l) => l.text().startsWith(label))!.get("input");
const options = (w: W, field: ReturnType<typeof input>) =>
  w.get(`datalist[id="${field.attributes("list")}"]`).findAll("option").map((o) => o.attributes("value"));

describe("suggestions in the edit dialog", () => {
  it("offers your own brands at once, and the catalog's after the field's first focus", async () => {
    fetchBrands.mockClear();
    const w = open();
    const brand = input(w, "Brand");
    expect(brand.attributes("placeholder")).toBe("Add a brand");
    expect(options(w, brand)).toEqual(["Zpacks", "Fjällräven"]);
    expect(fetchBrands).not.toHaveBeenCalled();
    await brand.trigger("focus");
    await vi.waitFor(() => expect(options(w, brand)).toHaveLength(4));
    // yours first, and a catalog label you already use (any capitalisation) only once
    expect(options(w, brand)).toEqual(["Zpacks", "Fjällräven", "Durston", "Patagonia"]);
  });

  it("does the same under Gear type", async () => {
    const w = open();
    const type = input(w, "Gear type");
    await type.trigger("focus");
    await flushPromises();
    await vi.waitFor(() => expect(options(w, type)).toEqual(["Quilt", "Sleeping pad", "Tent"]));
  });

  it("asks for a size with a placeholder, not an example", () => {
    expect(input(open(), "Size or version").attributes("placeholder")).toBe("Add a size");
  });
});
