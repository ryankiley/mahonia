// One product in several sizes reads as the product, once, over its sizes.
//
// A product's name typed in full ("alphalite") answers with every size it is sold in,
// and those rows differ only in the variant — which, laid out as ordinary rows, is the
// part that yields first under width pressure. On a phone every row read "El Coy…
// AlphaLite 900 Qu… · 10F, …": the one thing being chosen between was the one thing cut.
// So a run of sizes gets the product as a heading and each row leads with its size.
//
// What's pinned: every row SHOWS its size; every option's accessible name is still the
// whole product (the heading is presentation, so the name rides in each row); a run is
// only consecutive rows, so the ranker's order — and arrow-key nav over it — is untouched.
// happy-dom lays nothing out, so "shows" means the size is in the row's own visible text,
// not its hidden prefix.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import ItemInput from "~/components/ItemInput.vue";
import { vaultWithHits } from "./helpers/gearList";

let catalogHits: Record<string, unknown>[] = [];
registerEndpoint("/api/catalog/search", () => ({ results: catalogHits }));
registerEndpoint("/api/catalog/use", { method: "POST", handler: () => ({ ok: true }) });
mockNuxtImport("useVaultAccess", () => () => vaultWithHits([]));

enableAutoUnmount(afterEach);

const quilt = (id: number, variant: string, grams: number) => ({
  id,
  brand: "El Coyote",
  name: "AlphaLite 900 Quilt",
  variant,
  weightMg: grams * 1000,
  verified: true,
  categoryHint: "sleep",
});
const SIZES = [quilt(1, "10F, Regular", 612), quilt(2, "10F, Long", 650), quilt(3, "20F, Regular", 540)];
const OTHER = { id: 9, brand: "El Coyote", name: "AlphaLite Hood", variant: null, weightMg: 60_000, verified: true, categoryHint: "sleep" };

async function menuFor(hits: Record<string, unknown>[]) {
  catalogHits = hits;
  const w = mount(ItemInput, { props: { unit: "g", clearOnCommit: true }, attachTo: document.body });
  const input = w.find<HTMLInputElement>("input").element;
  input.focus();
  input.value = "alphalite";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(w.findAll('[role="option"]').length).toBe(hits.length), { timeout: 2_000 });
  return { w, input };
}

/** What a row shows: its text without the visually-hidden accessible-name prefix.
 *  textContent, so the parts run together where the layout would space them ("El
 *  CoyoteAlphaLite") — the assertions below look for the parts, not the spacing. */
const visibleText = (el: Element) => {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll(".visually-hidden").forEach((n) => n.remove());
  return copy.textContent!;
};
const options = (w: Awaited<ReturnType<typeof menuFor>>["w"]) => w.findAll('[role="option"]');

describe("a product in several sizes", () => {
  it("is named once, over its sizes", async () => {
    const { w } = await menuFor(SIZES);
    const heads = w.findAll(".ac__product");
    expect(heads).toHaveLength(1);
    expect(heads[0]!.find(".ac__brand").text()).toBe("El Coyote");
    expect(heads[0]!.find(".ac__model").text()).toBe("AlphaLite 900 Quilt");
    // and the heading is not an option: it can't be arrowed onto or counted
    expect(heads[0]!.attributes("role")).toBe("presentation");
    // it sits directly over the first of its sizes
    expect(heads[0]!.element.nextElementSibling).toBe(options(w)[0]!.element);
  });

  it("leads each row with its size, the part that differs", async () => {
    const { w } = await menuFor(SIZES);
    const rows = options(w);
    expect(rows.map((o) => o.find(".ac__size").text())).toEqual(["10F, Regular", "10F, Long", "20F, Regular"]);
    // the shared name is said once, above — not again on every row
    for (const o of rows) expect(visibleText(o.element)).not.toContain("AlphaLite");
    expect(rows.map((o) => o.find(".ac__w").text().replace(/\s+/g, " "))).toEqual(["612 g", "650 g", "540 g"]);
  });

  it("keeps the whole product in each option's accessible name", async () => {
    const { w } = await menuFor(SIZES);
    for (const [i, o] of options(w).entries()) {
      expect(o.find(".visually-hidden").text()).toBe("El Coyote AlphaLite 900 Quilt ·");
      expect(o.text()).toContain(SIZES[i]!.variant);
    }
  });

  // the ranker's order is the menu's order; a product ranked between two sizes splits
  // them rather than being regrouped around
  it("groups only consecutive rows, and leaves the rest as full rows", async () => {
    const { w } = await menuFor([SIZES[0]!, SIZES[1]!, OTHER, SIZES[2]!]);
    expect(w.findAll(".ac__product")).toHaveLength(1);
    const rows = options(w);
    expect(rows.map((o) => o.classes("ac__opt--size"))).toEqual([true, true, false, false]);
    expect(visibleText(rows[2]!.element)).toContain("AlphaLite Hood");
    // the stray size reads as an ordinary row, product and size together
    expect(visibleText(rows[3]!.element)).toContain("AlphaLite 900 Quilt");
    expect(rows[3]!.find(".ac__variant").text()).toContain("20F, Regular");
  });

  it("leaves a lone size as an ordinary row", async () => {
    const { w } = await menuFor([SIZES[0]!, OTHER]);
    expect(w.findAll(".ac__product")).toHaveLength(0);
    const first = options(w)[0]!;
    expect(first.classes("ac__opt--size")).toBe(false);
    expect(first.find(".ac__model").text()).toBe("AlphaLite 900 Quilt");
    expect(first.find(".ac__variant").text()).toContain("10F, Regular");
  });

  it("walks the same options with the arrow keys", async () => {
    const { w, input } = await menuFor(SIZES);
    await w.find("input").trigger("keydown", { key: "ArrowDown" });
    await w.find("input").trigger("keydown", { key: "ArrowDown" });
    const lit = options(w).filter((o) => o.classes("is-active"));
    expect(lit).toHaveLength(1);
    expect(lit[0]!.find(".ac__size").text()).toBe("10F, Long");
    expect(input.getAttribute("aria-activedescendant")).toBe(lit[0]!.attributes("id"));
  });
});
