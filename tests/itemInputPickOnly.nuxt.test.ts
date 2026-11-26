// /gear's add row uses the list editor's name field in two narrower modes. Catalog-only:
// the add row adds TO My Gear, so offering your own gear back would only offer a
// duplicate, and water isn't gear. Pick-only: the row is a name AND a weight, so the
// list row's commit-on-blur would fire on tabbing across to the weight; typed text
// waits for the form's submit instead, and only a pick commits.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import ItemInput from "~/components/ItemInput.vue";
import { typeInto } from "./helpers/dom";
import type { NameCommit } from "~/composables/useCatalogSearch";
import { vaultWithHits } from "./helpers/gearList";

let catalogHits: Record<string, unknown>[] = [];
let vaultHits: Record<string, unknown>[] = [];
registerEndpoint("/api/catalog/search", () => ({ results: catalogHits }));
registerEndpoint("/api/catalog/use", { method: "POST", handler: () => ({ ok: true }) });
mockNuxtImport("useVaultAccess", () => () => vaultWithHits(vaultHits));

enableAutoUnmount(afterEach);

const LONG = { id: 1, brand: "Zpacks", name: "Duplex", variant: "Long", weightMg: 560_000, verified: true, categoryHint: "shelter" };
const REGULAR = { id: 2, brand: "Zpacks", name: "Duplex", variant: "Regular", weightMg: 545_000, verified: true, categoryHint: "shelter" };
const MINE = { id: 9, brand: "Zpacks", name: "Duplex", variant: "Mine", weightMg: 600_000, normKey: "zpacksduplexmine", timesSeen: 1, lastUsedAt: "", createdAt: "" };

function mountAddField() {
  const w = mount(ItemInput, { props: { unit: "g", sources: "catalog", pickOnly: true }, attachTo: document.body });
  const input = w.find<HTMLInputElement>("input").element;
  return {
    w,
    input,
    commits: () => (w.emitted("commit") ?? []).map((e) => e[0] as NameCommit),
    submits: () => (w.emitted("submit") ?? []).length,
  };
}
async function typeAndSettle(w: ReturnType<typeof mount>, input: HTMLInputElement, text: string) {
  typeInto(input, text);
  await vi.waitFor(() => expect(w.findAll('[role="option"]').length).toBeGreaterThan(0), { timeout: 2_000 });
}

describe("the add row's name field: the catalog only, and only picks commit", () => {
  it("offers the catalog and never your own gear", async () => {
    catalogHits = [LONG, REGULAR];
    vaultHits = [MINE];
    const { w, input } = mountAddField();
    await typeAndSettle(w, input, "duplex");
    // give the vault half the same debounce it would need to land, had it been asked
    await new Promise((r) => setTimeout(r, 300));
    const opts = w.findAll('[role="option"]').map((o) => o.text());
    expect(opts).toHaveLength(2);
    expect(opts.join(" ")).not.toContain("Mine");
    expect(w.text()).not.toContain("My Gear");
  });

  it("offers no water row", async () => {
    catalogHits = [];
    vaultHits = [];
    const { w, input } = mountAddField();
    typeInto(input, "water 1 L");
    await new Promise((r) => setTimeout(r, 300));
    expect(w.findAll('[role="option"]')).toHaveLength(0);
  });

  it("commits nothing when focus leaves, so tabbing to the weight keeps the text", async () => {
    catalogHits = [LONG, REGULAR];
    vaultHits = [];
    const { w, input, commits } = mountAddField();
    await typeAndSettle(w, input, "Zpacks Duplex");
    await w.find(".ac").trigger("focusout", { relatedTarget: document.body });
    expect(commits()).toEqual([]);
    expect(input.value).toBe("Zpacks Duplex");
  });

  it("hands Enter on typed text to the form", async () => {
    catalogHits = [LONG, REGULAR];
    vaultHits = [];
    const { w, input, commits, submits } = mountAddField();
    await typeAndSettle(w, input, "Zpacks Duplex");
    await w.find("input").trigger("keydown", { key: "Enter" });
    expect(submits()).toBe(1);
    expect(commits()).toEqual([]);
  });

  it("still links a product typed in full", async () => {
    catalogHits = [LONG, REGULAR];
    vaultHits = [];
    const { w, input, commits, submits } = mountAddField();
    await typeAndSettle(w, input, "Zpacks Duplex Long");
    await w.find("input").trigger("keydown", { key: "Enter" });
    expect(commits()).toEqual([expect.objectContaining({ catalogItemId: 1, variant: "Long" })]);
    expect(submits()).toBe(0);
  });

  it("reports the text as it is typed, for the form to submit", async () => {
    catalogHits = [];
    vaultHits = [];
    const { w, input } = mountAddField();
    input.value = "Homemade stuff sack";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(w.emitted("draft")?.at(-1)).toEqual(["Homemade stuff sack"]));
  });
});
