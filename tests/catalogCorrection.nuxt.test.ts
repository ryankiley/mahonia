// The "fix a catalog weight" dialog is closed, open on one target, or sending for it. The
// button is gated while it sends, but Enter in any field comes straight through, and a
// request outlives the dialog it was sent from.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import CatalogCorrectionModal from "~/components/CatalogCorrectionModal.vue";

const TARGET = {
  catalogItemId: 5,
  itemName: "Duplex",
  catalogWeightMg: 500_000,
  suggestedMg: 510_000,
  displayUnit: "g" as const,
};

let release = () => {};
let held = Promise.resolve();
let posts = 0;
registerEndpoint("/api/catalog/correct", {
  method: "POST",
  handler: async () => {
    posts++;
    await held;
    return { status: "applied" };
  },
});

enableAutoUnmount(afterEach);

function openDialog() {
  useCatalogCorrection().open(TARGET);
  return mount(CatalogCorrectionModal, {
    global: { stubs: { BaseModal: { template: "<div><slot /></div>" } } },
  });
}
const pressEnter = (w: ReturnType<typeof openDialog>) => w.get("input").trigger("keydown", { key: "Enter" });

describe("sending a catalog correction", () => {
  beforeEach(() => {
    held = new Promise((r) => (release = r));
    posts = 0;
    useCatalogCorrection().close();
  });

  it("sends once on a double Enter, and reports once", async () => {
    const w = openDialog();
    await nextTick();
    await pressEnter(w);
    await pressEnter(w);
    await vi.waitFor(() => expect(posts).toBe(1));

    release();
    await vi.waitFor(() => expect(w.emitted("done")).toHaveLength(1));
    expect(useCatalogCorrection().target.value).toBeNull();
    expect(posts).toBe(1);
  });

  it("is not sending once the dialog has closed", async () => {
    const c = useCatalogCorrection();
    const w = openDialog();
    await nextTick();
    await pressEnter(w);
    await vi.waitFor(() => expect(posts).toBe(1));
    expect(c.submitting.value).toBe(true);

    c.close();
    expect(c.submitting.value).toBe(false);
    release();
  });

  it("leaves another item's dialog up when a cancelled request lands", async () => {
    const c = useCatalogCorrection();
    const w = openDialog();
    await nextTick();
    await pressEnter(w);
    await vi.waitFor(() => expect(posts).toBe(1));

    c.close();
    const other = { ...TARGET, catalogItemId: 6, itemName: "Kakwa 40" };
    c.open(other);
    release();
    await vi.waitFor(() => expect(w.emitted("done")).toHaveLength(1));
    await nextTick();
    expect(c.target.value).toEqual(other);
    expect(c.submitting.value).toBe(false);
  });

  afterEach(() => release());
});

// The card asks for one figure and arrives holding a suggestion for it, so the field
// opens focused with the suggestion's number selected: a typed number replaces it. The
// unit stays outside the selection, because a figure sent without one is read as grams.
describe("where the catalog correction opens", () => {
  it("puts the caret in the weight, with the number selected and the unit left", async () => {
    useCatalogCorrection().open(TARGET);
    const w = mount(CatalogCorrectionModal, {
      attachTo: document.body,
      global: { stubs: { BaseModal: { template: "<div><slot /></div>" } } },
    });
    await nextTick();
    const field = w.get<HTMLInputElement>("input").element;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("510 g");
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 3]);
    useCatalogCorrection().close();
  });
});
