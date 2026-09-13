// @vitest-environment nuxt
//
// Typing a product's full name and tabbing away links it, the way picking it from the
// menu would: the CSV import already links the same text word for word, and a typed
// row that spells a catalog product exactly was an unlinked shadow of it, with no
// weight and no live name. Only what the menu already fetched: no request of its own.
//
// Mounted because the decision reads two live result lists (the vault's and the
// catalog's, debounced 140ms behind the keystroke) at the moment focus leaves, and
// that timing is the case: results in hand link, results not yet in hand commit free
// text as before.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { ref } from "vue";
import ItemInput from "~/components/ItemInput.vue";
import type { NameCommit } from "~/composables/useCatalogSearch";

// what the two halves of the menu answer with, per case
let catalogHits: Record<string, unknown>[] = [];
let vaultHits: Record<string, unknown>[] = [];
registerEndpoint("/api/catalog/search", () => ({ results: catalogHits }));
registerEndpoint("/api/catalog/use", { method: "POST", handler: () => ({ ok: true }) });
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  vaultKnown: ref(true),
  vaultFetch: () => Promise.resolve({ results: vaultHits }),
}));

enableAutoUnmount(afterEach);

const LONG = { id: 1, brand: "Zpacks", name: "Duplex", variant: "Long", weightMg: 560_000, verified: true, categoryHint: "shelter" };
const REGULAR = { id: 2, brand: "Zpacks", name: "Duplex", variant: "Regular", weightMg: 545_000, verified: true, categoryHint: "shelter" };
const PLEX = { id: 3, brand: "Zpacks", name: "Plex Solo", variant: null, weightMg: 411_000, verified: true, categoryHint: "shelter" };

function mountInput() {
  const w = mount(ItemInput, { props: { unit: "g", clearOnCommit: true }, attachTo: document.body });
  const input = w.find<HTMLInputElement>("input").element;
  return { w, input, commits: () => (w.emitted("commit") ?? []).map((e) => e[0] as NameCommit) };
}

/** Type as a person does, then wait for the menu to have answered. */
async function typeAndSettle(w: ReturnType<typeof mount>, input: HTMLInputElement, text: string) {
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(w.findAll('[role="option"]').length).toBeGreaterThan(0), { timeout: 2_000 });
}
const blur = (w: ReturnType<typeof mount>) => w.find(".ac").trigger("focusout", { relatedTarget: document.body });

describe("a product name typed in full", () => {
  it("links on blur, exactly as picking it would", async () => {
    catalogHits = [LONG, REGULAR, PLEX];
    vaultHits = [];
    const { w, input, commits } = mountInput();
    await typeAndSettle(w, input, "Zpacks Duplex Long");
    await blur(w);
    expect(commits()).toEqual([expect.objectContaining({ name: "Duplex", brand: "Zpacks", variant: "Long", catalogItemId: 1, weightMg: 560_000 })]);
  });

  it("points the menu at the product as soon as the results settle", async () => {
    catalogHits = [PLEX, LONG, REGULAR];
    vaultHits = [];
    const { w, input } = mountInput();
    await typeAndSettle(w, input, "Zpacks Duplex Long");
    const lit = w.findAll('[role="option"]').filter((o) => o.classes("is-active"));
    expect(lit).toHaveLength(1);
    expect(lit[0]!.text()).toContain("Long");
    expect(input.getAttribute("aria-activedescendant")).toBe(lit[0]!.attributes("id"));
  });

  it("points at nothing when the name is ambiguous or a near miss", async () => {
    catalogHits = [LONG, REGULAR];
    vaultHits = [];
    const { w, input } = mountInput();
    await typeAndSettle(w, input, "Zpacks Duplex");
    expect(w.findAll('[role="option"].is-active')).toHaveLength(0);
  });

  it("links brand + model when the product has no sizes", async () => {
    catalogHits = [LONG, REGULAR, PLEX];
    vaultHits = [];
    const { w, input, commits } = mountInput();
    await typeAndSettle(w, input, "zpacks plex solo");
    await blur(w);
    expect(commits()).toEqual([expect.objectContaining({ catalogItemId: 3 })]);
  });

  it("stays free text when two sizes answer to the same name", async () => {
    catalogHits = [LONG, REGULAR];
    vaultHits = [];
    const { w, input, commits } = mountInput();
    await typeAndSettle(w, input, "Zpacks Duplex");
    await blur(w);
    expect(commits()).toEqual([{ name: "Zpacks Duplex", weight: undefined, classification: undefined }]);
  });

  it("stays free text on a near miss", async () => {
    catalogHits = [LONG, REGULAR, PLEX];
    vaultHits = [];
    const { w, input, commits } = mountInput();
    await typeAndSettle(w, input, "Zpacks Duplx Long");
    await blur(w);
    expect(commits()[0]!.catalogItemId).toBeUndefined();
    expect(commits()[0]!.name).toBe("Zpacks Duplx Long");
  });

  it("prefers your own gear, with your weight", async () => {
    catalogHits = [LONG];
    vaultHits = [{ id: 9, brand: "Zpacks", name: "Duplex", variant: "Long", weightMg: 571_000, catalogItemId: 1, normKey: "zpacks duplex long" }];
    const { w, input, commits } = mountInput();
    await typeAndSettle(w, input, "Zpacks Duplex Long");
    await blur(w);
    expect(commits()).toEqual([expect.objectContaining({ fromVault: true, weightMg: 571_000, catalogItemId: 1 })]);
  });

  // "water 2 L" tabbed away from is the water row at that volume, as the menu's water
  // option makes it; before, only the menu path read the volume
  it("makes the water row from a typed water phrase on blur", async () => {
    catalogHits = [];
    vaultHits = [];
    const { w, input, commits } = mountInput();
    input.focus();
    input.value = "water 2 L";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await blur(w);
    expect(commits()).toEqual([{ name: "Water", weightMg: 2_000_000, classification: "consumable" }]);
  });

  // the search is 140ms behind the keystroke; a tab faster than that has nothing to
  // link against, and the row is what it always was: free text
  it("commits free text when the menu has not answered yet", async () => {
    catalogHits = [LONG, REGULAR, PLEX];
    vaultHits = [];
    const { w, input, commits } = mountInput();
    input.focus();
    input.value = "Zpacks Duplex Long";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await blur(w);
    expect(commits()).toEqual([{ name: "Zpacks Duplex Long", weight: undefined, classification: undefined }]);
  });
});
