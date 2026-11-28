// The "fix a catalog weight" dialog is closed, open on one target, or sending for it. The
// button is gated while it sends, but Enter in any field comes straight through, and a
// request outlives the dialog it was sent from.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBody } from "h3";
import { registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
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
let lastBody: { weightMg?: number } | null = null;
registerEndpoint("/api/catalog/correct", {
  method: "POST",
  handler: async (event) => {
    posts++;
    lastBody = await readBody(event);
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

// The server reads a figure with no unit as grams. The card shows the list's unit, so a
// bare number typed over "17.99 oz" means ounces, as it does in a row's weight field.
describe("what a typed catalog correction is sent as", () => {
  const typed = async (text: string, displayUnit: "g" | "oz") => {
    held = Promise.resolve();
    lastBody = null;
    useCatalogCorrection().open({ ...TARGET, displayUnit });
    const w = mount(CatalogCorrectionModal, {
      global: { stubs: { BaseModal: { template: "<div><slot /></div>" } } },
    });
    await nextTick();
    await w.get("input").setValue(text);
    await pressEnter(w);
    await vi.waitFor(() => expect(lastBody).not.toBeNull());
    useCatalogCorrection().close();
    return lastBody!;
  };

  it("reads a bare number in the unit the card shows", async () => {
    expect(await typed("18", "oz")).toMatchObject({ weightMg: 510_291 });
    expect(await typed("505", "g")).toMatchObject({ weightMg: 505_000 });
  });

  it("keeps a unit that was typed, whatever the card shows", async () => {
    expect(await typed("505 g", "oz")).toMatchObject({ weightMg: 505_000 });
  });

  // refused on the card, where the reason can be read, rather than sent to fail
  it("sends nothing it cannot read as a weight, and says why under the field", async () => {
    posts = 0;
    useCatalogCorrection().open(TARGET);
    const w = mount(CatalogCorrectionModal, {
      global: { stubs: { BaseModal: { template: "<div><slot /></div>" } } },
    });
    await nextTick();
    for (const text of ["heavy", "0"]) {
      await w.get("input").setValue(text);
      await pressEnter(w);
      await flushPromises();
      expect(w.get("[role=alert]").text()).toContain("isn’t a weight");
      expect(w.get("input").attributes("aria-invalid")).toBe("true");
    }
    expect(posts).toBe(0);
    expect(useCatalogCorrection().target.value).not.toBeNull();
    // typing again takes the line away
    await w.get("input").setValue("505");
    expect(w.find("[role=alert]").exists()).toBe(false);
    useCatalogCorrection().close();
  });

  it("still sends the exact figure when the field was never touched", async () => {
    held = Promise.resolve();
    lastBody = null;
    const w = openDialog();
    await nextTick();
    await pressEnter(w);
    await vi.waitFor(() => expect(lastBody).not.toBeNull());
    expect(lastBody).toMatchObject({ weightMg: 510_000 });
    useCatalogCorrection().close();
  });
});
