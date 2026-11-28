// A dialog's title wears .panel__title, the full ink the Account and Feedback titles
// have. Import, Import gear, Keyboard shortcuts and the rest used a bare .t-label, which
// is the size, weight and ink of the section heads inside them: "Keyboard shortcuts"
// read as one more group above "A row" and "While dragging".
import { afterEach, describe, expect, it } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import ImportModal from "~/components/ImportModal.vue";
import ShortcutsModal from "~/components/ShortcutsModal.vue";
import VaultImportModal from "~/components/VaultImportModal.vue";

mockNuxtImport("useVaultAccess", () => () => ({ hasVault: ref(true), vaultKnown: ref(true), vaultFetch: () => Promise.resolve({}) }));

enableAutoUnmount(afterEach);

const opts = { props: { open: true }, global: { stubs: { BaseModal: { template: "<div><slot /></div>" } } } };
/** The dialog's <h2>, as the two facts this file is about. */
const titleOf = (h2: { text(): string; classes(): string[] }) => ({ text: h2.text(), isTitle: h2.classes().includes("panel__title") });

describe("a dialog's title", () => {
  it("is drawn as the title, not as a section head", () => {
    expect(titleOf(mount(ImportModal, opts).get("h2"))).toEqual({ text: "Import a list", isTitle: true });
    expect(titleOf(mount(VaultImportModal, opts).get("h2"))).toEqual({ text: "Import gear", isTitle: true });
    expect(titleOf(mount(ShortcutsModal, opts).get("h2"))).toEqual({ text: "Keyboard shortcuts", isTitle: true });
  });
});

describe("the keyboard shortcuts sheet", () => {
  it("lays every group out on one grid, so the descriptions share a left edge", () => {
    const sheet = mount(ShortcutsModal, opts);
    const grid = sheet.get(".keys");
    expect(grid.findAll(".keys__group")).toHaveLength(3);
    // still a list of terms and descriptions inside each group
    expect(grid.findAll("dl")).toHaveLength(3);
    expect(grid.findAll("dt").length).toBe(grid.findAll("dd").length);
  });
});
