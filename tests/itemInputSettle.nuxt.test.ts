// The menu's two halves answer independently, and My Gear's rows go above the catalog's.
// `active` is an index, so the second answer landing used to shift what it pointed at:
// the exact product lit, then the row that arrived above it lit instead, and Enter took
// that row while Tab took the product. A pointer stays with its row.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import ItemInput from "~/components/ItemInput.vue";
import { typeInto } from "./helpers/dom";
import type { NameCommit } from "~/composables/useCatalogSearch";

const access = vi.hoisted(() => ({ vaultFetch: (() => Promise.resolve({})) as () => Promise<unknown> }));
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  vaultKnown: ref(true),
  vaultFetch: () => access.vaultFetch(),
}));

const PLEX = { id: 3, brand: "Zpacks", name: "Plex Solo", variant: null, weightMg: 411_000, verified: true, categoryHint: "shelter" };
const SHEET = { id: 9, brand: "Zpacks", name: "Plex Solo Groundsheet", weightMg: 100_000, normKey: "x", catalogItemId: null, timesSeen: 1 };
let catalogHits: Record<string, unknown>[] = [];
registerEndpoint("/api/catalog/search", () => ({ results: catalogHits }));
registerEndpoint("/api/catalog/use", { method: "POST", handler: () => ({ ok: true }) });

enableAutoUnmount(afterEach);

const lit = (w: ReturnType<typeof mount>) => w.findAll('[role="option"].is-active').map((o) => o.text());

/** Type a name with the catalog answering first and My Gear held back. */
async function typed(text: string, vaultRows: unknown[]) {
  let answer = () => {};
  const held = new Promise<void>((r) => (answer = r));
  access.vaultFetch = async () => {
    await held;
    return { results: vaultRows };
  };
  catalogHits = [PLEX];
  const w = mount(ItemInput, { props: { unit: "g", clearOnCommit: true }, attachTo: document.body });
  const input = w.find<HTMLInputElement>("input").element;
  typeInto(input, text);
  await vi.waitFor(() => expect(lit(w)).toHaveLength(1), { timeout: 2_000 });
  return { w, input, answer };
}

describe("a pointer on the menu while the other half answers", () => {
  it("stays on the product it was set on, so Enter takes what Tab would", async () => {
    const { w, input, answer } = await typed("Zpacks Plex Solo", [SHEET]);
    expect(lit(w)[0]).not.toContain("Groundsheet");

    answer();
    await vi.waitFor(() => expect(w.findAll('[role="option"]')).toHaveLength(2), { timeout: 2_000 });
    await nextTick();
    expect(lit(w)).toHaveLength(1);
    expect(lit(w)[0]).not.toContain("Groundsheet");
    expect(input.getAttribute("aria-activedescendant")).toBe(w.get('[role="option"].is-active').attributes("id"));

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await nextTick();
    const commits = (w.emitted("commit") ?? []).map((e) => e[0] as NameCommit);
    expect(commits).toEqual([expect.objectContaining({ name: "Plex Solo", catalogItemId: 3 })]);
  });

  it("moves onto your own copy when it replaces the catalog's row", async () => {
    const yours = { ...SHEET, name: "Plex Solo", brand: "Zpacks", catalogItemId: 3 };
    const { w, answer } = await typed("Zpacks Plex Solo", [yours]);

    answer();
    await vi.waitFor(() => expect(w.find(".ac__row, [role=option]").text()).toContain("100"), { timeout: 2_000 });
    await nextTick();
    expect(w.findAll('[role="option"]')).toHaveLength(1);
    expect(lit(w)).toHaveLength(1);
  });

  it("lets go when the row it was on has left the menu and nothing else is the match", async () => {
    const { w, answer } = await typed("Zpacks Plex Solo", [
      { ...SHEET, catalogItemId: 3, name: "Something else" },
    ]);

    answer();
    await vi.waitFor(() => expect(w.text()).toContain("Something else"), { timeout: 2_000 });
    await nextTick();
    expect(lit(w)).toEqual([]);
  });
});
