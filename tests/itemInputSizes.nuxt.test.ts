// A product sold in several versions is one row in the menu, and picking it opens its
// versions in the same menu: the version step.
//
// The catalog holds a row per size, and a menu of rows gave a quilt in sixteen sizes
// sixteen lines, lost four of them to the result cap, and scattered a jacket's Men's and
// Women's rows among its neighbours'. So the search answers with whole products, the menu
// names each once, and a product with versions doesn't commit when picked: the field
// stays on it, the menu lists its versions, and what is typed after its name narrows them.
//
// What's pinned: one option per product, saying how many versions; the step's heading and
// size-led rows, with the whole product still in each option's accessible name; narrowing
// by typing; the pick that comes out of it being the plain catalog pick; a size the
// catalog lacks landing as the person's own; and the fit last picked opening the next
// pair. happy-dom lays nothing out, so "shows" means the text is in the row's own visible
// text, not its hidden prefix.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import ItemInput from "~/components/ItemInput.vue";
import { typeInto } from "./helpers/dom";
import type { NameCommit } from "~/composables/useCatalogSearch";
import { vaultWithHits } from "./helpers/gearList";

let catalogHits: Record<string, unknown>[] = [];
registerEndpoint("/api/catalog/search", () => ({ results: catalogHits }));
registerEndpoint("/api/catalog/use", { method: "POST", handler: () => ({ ok: true }) });
mockNuxtImport("useVaultAccess", () => () => vaultWithHits([]));

enableAutoUnmount(afterEach);
beforeEach(() => localStorage.clear());

const quilt = (id: number, variant: string, grams: number) => ({
  id,
  brand: "El Coyote",
  name: "AlphaLite 900 Quilt",
  variant,
  weightMg: grams * 1000,
  verified: true,
  commonName: "Quilt",
  categoryHint: "sleep",
});
// as the search sends them: most picked first, not in reading order
const SIZES = [quilt(3, "20F, Regular", 540), quilt(1, "10F, Regular", 612), quilt(4, "20F, Regular Wide", 580), quilt(2, "10F, Long", 650)];
const HOOD = { id: 9, brand: "El Coyote", name: "AlphaLite Hood", variant: null, weightMg: 60_000, verified: true, categoryHint: "sleep" };
const jacket = (id: number, variant: string, grams: number) => ({
  id,
  brand: "Mountain Hardwear",
  name: "Ghost Whisperer Hoody",
  variant,
  weightMg: grams * 1000,
  verified: true,
  commonName: "Down jacket",
  categoryHint: "clothing",
});
const PAIR = [jacket(21, "Men's Medium", 249), jacket(22, "Women's", 240)];

async function menuFor(hits: Record<string, unknown>[], typed = "alphalite", options = 1) {
  catalogHits = hits;
  const w = mount(ItemInput, { props: { unit: "g", clearOnCommit: true }, attachTo: document.body });
  const input = w.find<HTMLInputElement>("input").element;
  typeInto(input, typed);
  await vi.waitFor(() => expect(w.findAll('[role="option"]').length).toBe(options), { timeout: 2_000 });
  return { w, input, commits: () => (w.emitted("commit") ?? []).map((e) => e[0] as NameCommit) };
}
type Menu = Awaited<ReturnType<typeof menuFor>>;
const options = (w: Menu["w"]) => w.findAll('[role="option"]');
const key = async (w: Menu["w"], k: string) => {
  await w.find("input").trigger("keydown", { key: k });
  await flushPromises();
};
/** Into the version step, the way a person gets there: arrow onto the product, Enter. */
async function openVersions(m: Menu) {
  await key(m.w, "ArrowDown");
  await key(m.w, "Enter");
  await vi.waitFor(() => expect(m.w.findAll(".ac__product")).toHaveLength(1));
}
/** Type on from where the field stands, as the keyboard would. */
const typeOn = async (m: Menu, more: string) => {
  typeInto(m.input, m.input.value + more);
  await flushPromises();
};
/** What a row shows: its text without the visually-hidden accessible-name prefix. */
const visibleText = (el: Element) => {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll(".visually-hidden").forEach((n) => n.remove());
  return copy.textContent!;
};
const sizesShown = (w: Menu["w"]) => options(w).map((o) => o.find(".ac__size").text());

describe("a product in several versions", () => {
  it("is one row in the menu, saying how many versions it has", async () => {
    const { w } = await menuFor([...SIZES, HOOD], "alphalite", 2);
    const rows = options(w);
    expect(visibleText(rows[0]!.element)).toContain("AlphaLite 900 Quilt");
    expect(rows[0]!.find(".ac__count").text()).toBe("4 versions");
    // no size and no weight on a product row: neither is one fact about it
    expect(rows[0]!.find(".ac__variant").exists()).toBe(false);
    expect(rows[0]!.find(".t-num").exists()).toBe(false);
    // a product with one version is that version's row, as it always was
    expect(visibleText(rows[1]!.element)).toContain("AlphaLite Hood");
    expect(rows[1]!.find(".ac__w").text().replace(/\s+/g, " ")).toBe("60 g");
  });

  it("is one row even when the search sends its versions apart", async () => {
    const { w } = await menuFor([SIZES[0]!, HOOD, SIZES[1]!], "alphalite", 2);
    expect(options(w)[0]!.find(".ac__count").text()).toBe("2 versions");
  });

  it("leaves a lone version as an ordinary row, product and size together", async () => {
    const { w } = await menuFor([SIZES[0]!, HOOD], "alphalite", 2);
    const first = options(w)[0]!;
    expect(first.find(".ac__model").text()).toBe("AlphaLite 900 Quilt");
    expect(first.find(".ac__variant").text()).toContain("20F, Regular");
  });

  it("does not commit when picked: the field stays on it and the menu lists its versions", async () => {
    const m = await menuFor(SIZES);
    await openVersions(m);
    expect(m.commits()).toEqual([]);
    expect(m.input.value).toBe("El Coyote AlphaLite 900 Quilt ");
    // named once, over its versions, and the heading is not an option
    const head = m.w.find(".ac__product");
    expect(head.find(".ac__brand").text()).toBe("El Coyote");
    expect(head.find(".ac__model").text()).toBe("AlphaLite 900 Quilt");
    expect(head.attributes("role")).toBe("presentation");
    expect(head.element.nextElementSibling).toBe(options(m.w)[0]!.element);
    // in reading order, each leading with its size and carrying its weight
    expect(sizesShown(m.w)).toEqual(["10F, Long", "10F, Regular", "20F, Regular", "20F, Regular Wide"]);
    expect(options(m.w).map((o) => o.find(".ac__w").text().replace(/\s+/g, " "))).toEqual(["650 g", "612 g", "540 g", "580 g"]);
    for (const o of options(m.w)) {
      expect(visibleText(o.element)).not.toContain("AlphaLite");
      expect(o.find(".visually-hidden").text()).toBe("El Coyote AlphaLite 900 Quilt ·");
    }
    // and says how a size that isn't listed gets in
    expect(m.w.find(".ac__hint").text()).toBe("Not listed? Type your size.");
  });

  it("opens on the version most people pick, the first the search sent", async () => {
    const m = await menuFor(SIZES);
    await openVersions(m);
    const lit = options(m.w).filter((o) => o.classes("is-active"));
    expect(lit.map((o) => o.find(".ac__size").text())).toEqual(["20F, Regular"]);
    expect(m.input.getAttribute("aria-activedescendant")).toBe(lit[0]!.attributes("id"));
  });

  it("walks its versions and the typed size with the arrow keys", async () => {
    const m = await menuFor(SIZES);
    await openVersions(m);
    await typeOn(m, "wide");
    // the one wide version, then the typed size ("wide" fits it without beginning it)
    expect(sizesShown(m.w)).toEqual(["20F, Regular Wide", "Add “wide”"]);
    const lit = () => options(m.w).findIndex((o) => o.classes("is-active"));
    expect(lit()).toBe(0);
    await key(m.w, "ArrowDown");
    expect(lit()).toBe(1);
    expect(m.input.getAttribute("aria-activedescendant")).toBe(options(m.w)[1]!.attributes("id"));
    await key(m.w, "ArrowDown");
    expect(lit()).toBe(0);
  });

  it("narrows as words are typed after the name, and lights the one they most nearly say", async () => {
    const m = await menuFor(SIZES);
    await openVersions(m);
    await typeOn(m, "20");
    expect(sizesShown(m.w).slice(0, 2)).toEqual(["20F, Regular", "20F, Regular Wide"]);
    await typeOn(m, " reg w");
    expect(options(m.w).filter((o) => o.classes("is-active")).map((o) => o.find(".ac__size").text())).toEqual(["20F, Regular Wide"]);
    // the hint is gone once words are typed, and a version being typed is not offered
    // back as a size of the person's own
    expect(m.w.find(".ac__hint").exists()).toBe(false);
    expect(options(m.w).map((o) => o.text()).join(" ")).not.toContain("Add");
    // words that fit a version without beginning it are: "wide" may be a size it lacks
    typeInto(m.input, "El Coyote AlphaLite 900 Quilt wide");
    await flushPromises();
    expect(sizesShown(m.w)).toEqual(["20F, Regular Wide", "Add “wide”"]);
  });

  it("commits the version picked exactly as a catalog row always committed", async () => {
    const m = await menuFor(SIZES);
    await openVersions(m);
    await typeOn(m, "20 reg w");
    await key(m.w, "Enter");
    expect(m.commits()).toEqual([
      expect.objectContaining({ name: "AlphaLite 900 Quilt", brand: "El Coyote", variant: "20F, Regular Wide", catalogItemId: 4, weightMg: 580_000 }),
    ]);
    // a finished pick: Enter goes on to a new row, as it does after any pick
    expect(m.w.emitted("advance")).toHaveLength(1);
  });

  it("goes back to searching when the name itself is edited", async () => {
    const m = await menuFor(SIZES);
    await openVersions(m);
    typeInto(m.input, "El Coyote AlphaLite 900 Qui");
    await vi.waitFor(() => expect(m.w.findAll(".ac__product")).toHaveLength(0));
    await vi.waitFor(() => expect(options(m.w)[0]!.find(".ac__count").exists()).toBe(true), { timeout: 2_000 });
  });

  it("carries a size typed along with the name into the step", async () => {
    const m = await menuFor(PAIR, "ghost whisperer hoody women");
    await openVersions(m);
    expect(m.input.value).toBe("Mountain Hardwear Ghost Whisperer Hoody women");
    expect(sizesShown(m.w)[0]).toBe("Women’s");
  });
});

describe("a size the catalog doesn't list", () => {
  it("lands as the person's own: the product's name and gear type, their size, no link, no weight", async () => {
    const m = await menuFor(PAIR, "ghost whisperer");
    await openVersions(m);
    await typeOn(m, "Large");
    // nothing fits "Large", so the typed size is the one row, and it is lit
    expect(options(m.w)).toHaveLength(1);
    expect(options(m.w)[0]!.classes("is-active")).toBe(true);
    await key(m.w, "Enter");
    expect(m.commits()).toEqual([{ name: "Ghost Whisperer Hoody", brand: "Mountain Hardwear", variant: "Large", commonName: "Down jacket", classification: undefined, own: true }]);
    // the weight comes next, not a new row
    expect(m.w.emitted("advance")).toBeUndefined();
  });

  it("is not offered for a size that IS listed, however it is spelled or however far typed", async () => {
    const m = await menuFor(PAIR, "ghost whisperer");
    await openVersions(m);
    await typeOn(m, "wom");
    expect(options(m.w).map((o) => o.text()).join(" ")).not.toContain("Add");
    await typeOn(m, "ens");
    expect(options(m.w)).toHaveLength(1);
    expect(options(m.w)[0]!.text()).not.toContain("Add");
  });

  it("is what leaving the field mid-step commits, when the words fit no version", async () => {
    const m = await menuFor(PAIR, "ghost whisperer");
    await openVersions(m);
    await typeOn(m, "Large");
    await m.w.find(".ac").trigger("focusout", { relatedTarget: document.body });
    expect(m.commits()).toEqual([expect.objectContaining({ variant: "Large", own: true })]);
  });
});

describe("leaving the field on a product", () => {
  it("picks the version the typed words name", async () => {
    const m = await menuFor(PAIR, "ghost whisperer");
    await openVersions(m);
    await typeOn(m, "wom");
    await m.w.find(".ac").trigger("focusout", { relatedTarget: document.body });
    expect(m.commits()).toEqual([expect.objectContaining({ catalogItemId: 22, variant: "Women's" })]);
  });

  // a choice not yet made is not a size: "20" fits four quilts, and nothing is invented
  it("commits the text as typed when the words still fit several versions", async () => {
    const m = await menuFor(SIZES);
    await openVersions(m);
    await typeOn(m, "20");
    await m.w.find(".ac").trigger("focusout", { relatedTarget: document.body });
    expect(m.commits()).toEqual([{ name: "El Coyote AlphaLite 900 Quilt 20", weight: undefined, classification: undefined }]);
    expect(m.commits()[0]!.own).toBeUndefined();
  });

  it("commits the name alone when no version was chosen: several versions is no one row", async () => {
    const m = await menuFor(PAIR, "ghost whisperer");
    await openVersions(m);
    await m.w.find(".ac").trigger("focusout", { relatedTarget: document.body });
    expect(m.commits()).toEqual([{ name: "Mountain Hardwear Ghost Whisperer Hoody", weight: undefined, classification: undefined }]);
  });
});

describe("leaving the version step for another product", () => {
  const tent = (id: number, name: string, variant: string | null) => ({
    id,
    brand: "Durston",
    name,
    variant,
    weightMg: 900_000 + id,
    verified: true,
    commonName: "Tent",
    categoryHint: "shelter",
  });
  const X2 = [tent(31, "X-Mid 2", "Silnylon"), tent(32, "X-Mid 2", "Polyester")];
  const SOLID = tent(33, "X-Mid 2 Solid", null);
  const PRO2 = [tent(41, "X-Mid Pro 2", "DCF"), tent(42, "X-Mid Pro 2", "DCF Ultra")];
  const PRO2PLUS = [tent(43, "X-Mid Pro 2+", "DCF"), tent(44, "X-Mid Pro 2+", "DCF Ultra")];

  it("offers another product's name above the typed size, and leaving the field takes it", async () => {
    const m = await menuFor([...X2, SOLID], "x-mid 2", 2);
    await openVersions(m);
    await typeOn(m, "Solid");
    await vi.waitFor(() => expect(options(m.w)).toHaveLength(2));
    const rows = options(m.w);
    // the typed size stays with the product; the other product sits apart, under its own
    // label, as a whole row (brand and model), not as a version of the X-Mid 2
    expect(rows[0]!.text()).toContain("Add “Solid”");
    expect(visibleText(rows[1]!.element)).toContain("X-Mid 2 Solid");
    expect(rows[1]!.classes("ac__opt--size")).toBe(false);
    expect(rows[1]!.find(".ac__brand").text()).toBe("Durston");
    expect(rows[1]!.element.previousElementSibling!.textContent).toBe("Other products");
    // and it is what's lit: the words more likely finish its name than name a size
    expect(rows[1]!.classes("is-active")).toBe(true);
    await m.w.find(".ac").trigger("focusout", { relatedTarget: document.body });
    expect(m.commits()).toEqual([expect.objectContaining({ catalogItemId: 33, name: "X-Mid 2 Solid" })]);
  });

  it("leaves the step for a plus straight after the name, or opening the words", async () => {
    for (const plus of ["+", " +"]) {
      const m = await menuFor([...PRO2, ...PRO2PLUS], "x-mid pro 2", 2);
      // the Pro 2 row, first
      await openVersions(m);
      await typeOn(m, plus);
      // a search again: both products, the Pro 2+ among them, and no version step
      await vi.waitFor(() => expect(m.w.findAll(".ac__product")).toHaveLength(0));
      await vi.waitFor(() => expect(options(m.w).some((o) => visibleText(o.element).includes("X-Mid Pro 2+"))).toBe(true), { timeout: 2_000 });
      m.w.unmount();
    }
  });
});

describe("the fit last picked", () => {
  it("is the version the next Men's / Women's pair opens on", async () => {
    // nothing remembered: the most picked, the first sent
    const first = await menuFor(PAIR, "ghost whisperer");
    await openVersions(first);
    expect(options(first.w).filter((o) => o.classes("is-active")).map((o) => o.find(".ac__size").text())).toEqual(["Men’s Medium"]);
    // pick the Women's
    await key(first.w, "ArrowDown");
    await key(first.w, "Enter");
    expect(first.commits()).toEqual([expect.objectContaining({ catalogItemId: 22 })]);
    first.w.unmount();

    const again = await menuFor(PAIR, "ghost whisperer");
    await openVersions(again);
    expect(options(again.w).filter((o) => o.classes("is-active")).map((o) => o.find(".ac__size").text())).toEqual(["Women’s"]);
  });
});
