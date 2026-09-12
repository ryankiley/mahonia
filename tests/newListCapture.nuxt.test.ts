// @vitest-environment nuxt
//
// New lists are device-owned, but their initial vault capture is not. A slow
// create can outlive a forced session refresh from account A to account B; that
// response must not bank gear, close A's dialog, register the list, or navigate B.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, ref } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { csvToListData } from "~~/shared/exporters/csv";
import type { ListSnapshot } from "~~/shared/types";
import ImportModal from "~/components/ImportModal.vue";
import { useCopyList } from "~/composables/useCopyList";

// `mockNuxtImport` factories are hoisted before regular module initialization.
// Keep the small test boundary in `vi.hoisted` so those factories and the cases
// below deliberately share the same account lifetime.
const state = vi.hoisted(() => ({
  captureNewList: vi.fn(),
  registerCreated: vi.fn(() => "new-edit-token"),
  navigateTo: vi.fn(() => Promise.resolve()),
  importNote: { value: null as string | null },
  tally: vi.fn(),
}));

const accountGeneration = ref(0);

mockNuxtImport("useVaultAccess", () => () => ({ accountGeneration }));
mockNuxtImport("useVaultCapture", () => () => ({ captureNewList: state.captureNewList }));
mockNuxtImport("useMyLists", () => () => ({ registerCreated: state.registerCreated }));
mockNuxtImport("useImportNote", () => () => state.importNote);
mockNuxtImport("navigateTo", () => state.navigateTo);
mockNuxtImport("tally", () => state.tally);

const snapshot = (title = "Source list"): ListSnapshot => ({
  shareCode: "NEWLIST00001",
  slug: "new-list-0001",
  title,
  description: "",
  displayUnit: "g",
  folders: [],
  items: [],
  version: 1,
  isPublic: false,
});

let blockCreate = false;
let createReleases: Array<() => void> = [];
registerEndpoint("/api/lists/create", {
  method: "POST",
  handler: async () => {
    if (blockCreate) await new Promise<void>((resolve) => createReleases.push(resolve));
    return { editToken: "new-edit-token", snapshot: snapshot("Imported copy") };
  },
});
registerEndpoint("/api/catalog/match", { method: "POST", handler: () => ({ matches: [null] }) });

let blockLighterpack = false;
let lighterpackReleases: Array<() => void> = [];
registerEndpoint("/api/import", {
  method: "POST",
  handler: async () => {
    if (blockLighterpack) await new Promise<void>((resolve) => lighterpackReleases.push(resolve));
    return { data: csvToListData("Item Name,Weight,Unit\nTent,500,g") };
  },
});

const BaseModalStub = defineComponent({
  props: { open: Boolean },
  template: '<div v-if="open"><slot /></div>',
});

beforeEach(() => {
  accountGeneration.value = 10;
  blockCreate = true;
  blockLighterpack = false;
  createReleases = [];
  lighterpackReleases = [];
  state.captureNewList.mockReset();
  state.registerCreated.mockClear();
  state.navigateTo.mockClear();
  state.tally.mockClear();
});

afterEach(() => {
  // Never strand an endpoint promise if an assertion fails halfway through a case.
  for (const release of createReleases) release();
  createReleases = [];
  for (const release of lighterpackReleases) release();
  lighterpackReleases = [];
});

describe("whole-list vault capture across an account switch", () => {
  it("does not apply a copied list's late result to the replacement account", async () => {
    const copying = useCopyList().copyList(snapshot());
    await vi.waitFor(() => expect(createReleases).toHaveLength(1));

    accountGeneration.value++;
    createReleases[0]!();
    await expect(copying).resolves.toBe(false);

    expect(state.captureNewList).not.toHaveBeenCalled();
    expect(state.registerCreated).not.toHaveBeenCalled();
    expect(state.navigateTo).not.toHaveBeenCalled();
  });

  it("does not apply an imported list's late result to the replacement account", async () => {
    const wrapper = mount(ImportModal, {
      props: { open: true },
      global: { stubs: { BaseModal: BaseModalStub } },
    });
    await wrapper.get("textarea.import__text").setValue("Item Name,Weight,Unit\nTent,500,g");
    await wrapper.get("button.btn--primary").trigger("click");
    await vi.waitFor(() => expect(createReleases).toHaveLength(1));

    accountGeneration.value++;
    createReleases[0]!();
    await flushPromises();

    expect(state.captureNewList).not.toHaveBeenCalled();
    expect(state.registerCreated).not.toHaveBeenCalled();
    expect(state.navigateTo).not.toHaveBeenCalled();
    expect(state.tally).not.toHaveBeenCalled();
    expect(wrapper.emitted("close")).toBeUndefined();
    wrapper.unmount();
  });

  it("does not apply an import after its dialog closes", async () => {
    const wrapper = mount(ImportModal, {
      props: { open: true },
      global: { stubs: { BaseModal: BaseModalStub } },
    });
    await wrapper.get("textarea.import__text").setValue("Item Name,Weight,Unit\nTent,500,g");
    await wrapper.get("button.btn--primary").trigger("click");
    await vi.waitFor(() => expect(createReleases).toHaveLength(1));

    await wrapper.setProps({ open: false });
    expect(wrapper.props("open")).toBe(false);
    createReleases[0]!();
    await flushPromises();

    expect(state.captureNewList).not.toHaveBeenCalled();
    expect(state.registerCreated).not.toHaveBeenCalled();
    expect(state.navigateTo).not.toHaveBeenCalled();
    expect(state.tally).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("keeps the initiating account through a delayed LighterPack resolution", async () => {
    blockCreate = false;
    blockLighterpack = true;
    const wrapper = mount(ImportModal, {
      props: { open: true },
      global: { stubs: { BaseModal: BaseModalStub } },
    });
    await wrapper.get("textarea.import__text").setValue("https://lighterpack.com/r/pack123");
    await wrapper.get("button.btn--primary").trigger("click");
    await vi.waitFor(() => expect(lighterpackReleases).toHaveLength(1));

    accountGeneration.value++;
    lighterpackReleases[0]!();
    await flushPromises();

    expect(state.captureNewList).not.toHaveBeenCalled();
    expect(state.registerCreated).not.toHaveBeenCalled();
    expect(state.navigateTo).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("keeps the initiating account through a delayed file read", async () => {
    blockCreate = false;
    const readers: Array<{ result: string | null; onload: (() => void) | null }> = [];
    class DeferredReader {
      result: string | null = null;
      onload: (() => void) | null = null;

      readAsText() {
        readers.push(this);
      }
    }
    vi.stubGlobal("FileReader", DeferredReader);
    const wrapper = mount(ImportModal, {
      props: { open: true },
      global: { stubs: { BaseModal: BaseModalStub } },
    });
    try {
      const input = wrapper.get('input[type="file"]').element as HTMLInputElement;
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [{ name: "gear.csv", type: "text/csv" }],
      });
      await wrapper.get('input[type="file"]').trigger("change");
      expect(readers).toHaveLength(1);

      accountGeneration.value++;
      readers[0]!.result = "Item Name,Weight,Unit\nTent,500,g";
      readers[0]!.onload?.();
      await flushPromises();

      expect(state.captureNewList).not.toHaveBeenCalled();
      expect(state.registerCreated).not.toHaveBeenCalled();
    } finally {
      wrapper.unmount();
      vi.unstubAllGlobals();
    }
  });
});
