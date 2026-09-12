// @vitest-environment nuxt
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import type { VaultEntry } from "~~/shared/vault";
import VaultItemModal from "~/components/VaultItemModal.vue";

const vaultFetch = vi.fn();
mockNuxtImport("useVaultAccess", () => () => ({ vaultFetch }));

const entry = (id: number, name: string): VaultEntry => ({
  id,
  name,
  brand: "Brand",
  weightMg: 250_000,
  normKey: `brand|${name.toLowerCase()}|`,
  timesSeen: 1,
  lastUsedAt: "2026-08-01T00:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
});

const BaseModalStub = defineComponent({
  props: { open: Boolean },
  template: '<div v-if="open"><slot /></div>',
});

describe("VaultItemModal", () => {
  afterEach(() => vaultFetch.mockReset());

  it("does not emit an old save after the dialog changes to another entry", async () => {
    let finish!: (value: { ok: boolean; item: VaultEntry }) => void;
    vaultFetch.mockImplementationOnce(
      () => new Promise<{ ok: boolean; item: VaultEntry }>((resolve) => (finish = resolve)),
    );
    const first = entry(1, "Old pack");
    const second = entry(2, "New tent");
    const wrapper = mount(VaultItemModal, {
      props: { entry: first, unit: "g" },
      global: { stubs: { BaseModal: BaseModalStub, OptionMenu: true } },
    });

    await wrapper.findAll("input")[2]!.setValue("Old pack revised");
    await wrapper.get("button.btn--primary").trigger("click");
    await wrapper.setProps({ entry: second });
    finish({ ok: true, item: { ...first, name: "Old pack revised" } });
    await flushPromises();

    expect(wrapper.emitted("saved")).toBeUndefined();
  });
});
