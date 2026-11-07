// The "Import gear" dialog's steps: the form, the request, the outcome. One import at a
// time, because the file button stays live beside a request in flight and choosing a
// file imports straight away.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import VaultImportModal from "~/components/VaultImportModal.vue";

const vaultFetch = vi.fn();
mockNuxtImport("useVaultAccess", () => () => ({ vaultFetch }));

const CSV = "Item Name,Weight\nDuplex,510\n";

enableAutoUnmount(afterEach);

function openDialog() {
  return mount(VaultImportModal, {
    props: { open: true },
    global: { stubs: { BaseModal: { template: "<div><slot /></div>" } } },
  });
}
type Dialog = ReturnType<typeof openDialog>;

const primary = (w: Dialog) => w.get("button.btn--primary");
const fileChosen = async (w: Dialog, text: string) => {
  w.findComponent({ name: "FilePickButton" }).vm.$emit("text", text, new File([text], "gear.csv"));
  await nextTick();
};

describe("importing gear", () => {
  afterEach(() => vaultFetch.mockReset());

  it("shows the outcome in place of the form", async () => {
    vaultFetch.mockResolvedValue({ ok: true, added: 2, skipped: 1 });
    const w = openDialog();
    await fileChosen(w, CSV);
    await vi.waitFor(() => expect(w.text()).toContain("Added 2 pieces of gear. 1 was already yours."));
    expect(w.find("textarea").exists()).toBe(false);
    expect(w.emitted("imported")).toHaveLength(1);
  });

  it("runs one import at a time when a file arrives during a request", async () => {
    let answer!: (r: unknown) => void;
    vaultFetch.mockReturnValue(new Promise((r) => (answer = r)));
    const w = openDialog();
    await fileChosen(w, CSV);
    expect(primary(w).text()).toBe("Importing…");
    expect(primary(w).attributes("disabled")).toBeDefined();

    await fileChosen(w, CSV);
    expect(vaultFetch).toHaveBeenCalledTimes(1);

    answer({ ok: true, added: 1, skipped: 0 });
    await vi.waitFor(() => expect(w.text()).toContain("Added 1 piece of gear."));
  });

  it("goes back to the form with the reason when the request fails", async () => {
    vaultFetch.mockRejectedValue(new Error("offline"));
    const w = openDialog();
    await fileChosen(w, CSV);
    await vi.waitFor(() => expect(w.text()).toContain("Couldn’t import that."));
    expect(primary(w).text()).toBe("Import");
  });

  it("clears the reason when a retry starts", async () => {
    vaultFetch.mockRejectedValueOnce(new Error("offline"));
    const w = openDialog();
    await fileChosen(w, CSV);
    await vi.waitFor(() => expect(w.text()).toContain("Couldn’t import that."));

    vaultFetch.mockReturnValue(new Promise(() => {}));
    await fileChosen(w, CSV);
    expect(w.text()).not.toContain("Couldn’t import that.");
  });

  it("says so when the file holds no gear, without a request", async () => {
    const w = openDialog();
    await fileChosen(w, "not,a,list\n");
    expect(w.text()).toContain("No gear found in that.");
    expect(vaultFetch).not.toHaveBeenCalled();
  });

  it("keeps a closed opening's failure off the outcome that replaced it", async () => {
    let fail!: (e: Error) => void;
    vaultFetch.mockReturnValueOnce(new Promise((_, x) => (fail = x)));
    vaultFetch.mockResolvedValueOnce({ ok: true, added: 1, skipped: 0 });
    const w = openDialog();
    await fileChosen(w, CSV);
    await w.setProps({ open: false });
    await w.setProps({ open: true });
    await fileChosen(w, CSV);
    await vi.waitFor(() => expect(w.text()).toContain("Added 1 piece of gear."));

    fail(new Error("late"));
    await new Promise((r) => setTimeout(r, 10));
    expect(w.text()).toContain("Added 1 piece of gear.");
    expect(w.text()).not.toContain("Couldn’t import that.");
  });

  it("still reloads the page's gear when a closed opening's import lands", async () => {
    let land!: (r: unknown) => void;
    vaultFetch.mockReturnValueOnce(new Promise((r) => (land = r)));
    const w = openDialog();
    await fileChosen(w, CSV);
    await w.setProps({ open: false });
    await w.setProps({ open: true });

    land({ ok: true, added: 1, skipped: 0 });
    await vi.waitFor(() => expect(w.emitted("imported")).toHaveLength(1));
    expect(w.find("textarea").exists()).toBe(true); // the fresh form, not that outcome
  });

  it("starts over each time it opens", async () => {
    vaultFetch.mockResolvedValue({ ok: true, added: 1, skipped: 0 });
    const w = openDialog();
    await fileChosen(w, CSV);
    await vi.waitFor(() => expect(w.text()).toContain("Added 1 piece of gear."));

    await w.setProps({ open: false });
    await w.setProps({ open: true });
    expect(w.find("textarea").exists()).toBe(true);
    expect(w.text()).not.toContain("Added 1 piece of gear.");
  });
});
