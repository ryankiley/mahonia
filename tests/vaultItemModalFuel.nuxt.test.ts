// @vitest-environment nuxt
//
// MY GEAR'S EDIT DIALOG follows the editor row's two fuel rules — ItemRow's rule
// verbatim is the dialog's own stated principle — and it is the one surface where a
// number can be typed into a field that then hides: the name and gear type are edited
// live in the same form. So beyond the two rules, this pins that a kcal typed before the
// row was edited into fuel is dropped on save rather than written unseen, where the next
// list to pick the row would count it.
import { beforeEach, describe, expect, it } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { flushPromises, mount } from "@vue/test-utils";
import VaultItemModal from "~/components/VaultItemModal.vue";
import type { VaultEntry } from "~~/shared/vault";

// every save the dialog sends — the request body is what is under test
const sent: unknown[] = [];
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  vaultKnown: ref(true),
  vaultFetch: (_url: string, opts?: { body?: unknown }) => {
    sent.push(opts?.body);
    return Promise.resolve({ ok: true, item: entry("saved") });
  },
}));

const entry = (name: string, over: Partial<VaultEntry> = {}): VaultEntry => ({
  id: 1,
  normKey: name.toLowerCase(),
  name,
  weightMg: 110_000,
  classification: "consumable",
  timesSeen: 1,
  lastUsedAt: "2026-09-12T00:00:00Z",
  createdAt: "2026-09-12T00:00:00Z",
  ...over,
});

function open(e: VaultEntry) {
  return mount(VaultItemModal, { props: { entry: e, unit: "g" }, attachTo: document.body });
}
type W = ReturnType<typeof open>;
const fieldBy = (w: W, label: string) =>
  w.findAll("label.dlg__field").find((l) => l.text().startsWith(label))?.find("input");
const kcalField = (w: W) => fieldBy(w, "kcal each");
const typeOptions = async (w: W) => {
  await w.get(".vitem__cls .optmenu__btn").trigger("click");
  await nextTick();
  return w.findAll('[role="menuitem"]').map((o) => o.text());
};
const patchSent = () => (sent.at(-1) as { op: { patch: Record<string, unknown> } }).op.patch;

describe("the edit dialog on a fuel entry", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("offers no kcal field on fuel holding no number, and no Worn in its type picker", async () => {
    const w = open(entry("IsoPro Fuel Canister", { commonName: "Fuel canister" }));
    expect(kcalField(w)).toBeUndefined();
    expect(await typeOptions(w)).toEqual(["Base", "Consumable"]);
    w.unmount();
  });

  it("offers both on food, and Worn again on fuel that already is worn", async () => {
    const food = open(entry("Trail mix", { commonName: "Snack" }));
    expect(kcalField(food)?.exists()).toBe(true);
    expect(await typeOptions(food)).toEqual(["Base", "Worn", "Consumable"]);
    food.unmount();
    const worn = open(entry("Gas canister", { classification: "worn" }));
    expect(await typeOptions(worn)).toEqual(["Base", "Worn", "Consumable"]);
    worn.unmount();
  });

  it("drops a kcal typed before the row was edited into fuel, rather than saving it unseen", async () => {
    const w = open(entry("Trail mix"));
    await kcalField(w)!.setValue("500");
    await fieldBy(w, "Gear type")!.setValue("Fuel canister");
    await nextTick();
    expect(kcalField(w)).toBeUndefined(); // the field went with the gear type
    await w.get("button.btn--primary").trigger("click");
    await flushPromises();
    expect(patchSent()).toEqual({ commonName: "Fuel canister" });
    w.unmount();
  });

  it("still clears a fuel row's stored calories, which is the one edit its field exists for", async () => {
    const w = open(entry("Gas canister", { kcal: 1350 }));
    const field = kcalField(w)!;
    expect(field.element.value).toBe("1350");
    await field.setValue("");
    await w.get("button.btn--primary").trigger("click");
    await flushPromises();
    expect(patchSent()).toEqual({ kcal: null });
    w.unmount();
  });
});
