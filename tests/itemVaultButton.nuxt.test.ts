// @vitest-environment nuxt
//
// The row's "Save to My Gear" button, which renders only while pressing it could
// do the thing it names. Two states hide it: a row that isn't yet gear (unnamed /
// unweighed — nothing to save), and a row the automatic capture path already
// banks (the vault answer is yes — offering to save what's saved is a placebo).
// In both, the button isn't dimmed, it's GONE: no inline icon, no ⋯-menu entry.
// A worthy row failing any covered gate keeps it as a live action, because
// pressing it is then the only way the row gets banked.
//
// Nuxt environment because the decision under test is what the ROW renders:
// whether the button exists at all, and whether a press reaches the controller.
// The condition spans the controller's mirror (vaultAuto / vaultDeclined), the
// session (hasVault), and the row's own worthiness — gearList.nuxt.test.ts proves
// the mirror tracks the stored answer; this file proves the row obeys the mirror.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { mount } from "@vue/test-utils";
import ItemRow, { CHILDREN_BY_PARENT, PEOPLE_CTX } from "~/components/ItemRow.vue";
import type { Item, ListSnapshot, Person } from "~~/shared/types";
import { vaultNormKey } from "~~/shared/vault";

// what GearEditor provides to every row — the children map, and the people in
// display order with their slots (this list names nobody)
const rowProvides = {
  [CHILDREN_BY_PARENT as symbol]: ref(new Map<string, Item[]>()),
  [PEOPLE_CTX as symbol]: { sorted: ref<Person[]>([]), slotById: ref(new Map<string, number>()) },
};

// The dials the covered state reads, reset per test. `vaultKnown` is the session
// having ANSWERED — false only in the moment before /api/auth/me lands.
const vaultAuto = ref(false);
const vaultDeclined = ref<Set<string>>(new Set());
const hasVault = ref(true);
const vaultKnown = ref(true);
const saveItemToVault = vi.fn(() => Promise.resolve("saved" as const));

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault,
  vaultKnown,
  vaultFetch: () => Promise.resolve({ results: [] }),
}));

mockNuxtImport("useGearList", () => () => ({
  pendingBlankId: ref<string | null>(null),
  updateItem: () => {},
  setItemWeight: () => {},
  removeItem: () => {},
  moveItem: () => {},
  discardEmpty: () => {},
  addBlankItemAfter: () => "",
  addChild: () => "",
  nestItem: () => {},
  unnest: () => {},
  saveItemToVault,
  vaultAuto,
  vaultDeclined,
}));

const list = {
  id: "l1",
  name: "Test",
  displayUnit: "g",
  folders: [{ id: "f1", name: "Shelter", sortOrder: 0 }],
  items: [],
} as unknown as ListSnapshot;

// a row capture would take: named, weighed, no children
const gear = (over: Partial<Item> = {}): Item => ({
  id: "i1",
  folderId: "f1",
  name: "Duplex",
  brand: "Zpacks",
  unitWeightMg: 539_000,
  qty: 1,
  classification: null,
  sortOrder: 0,
  ...over,
});

function mountRow(item: Item) {
  return mount(ItemRow, {
    props: { list, item },
    global: { provide: rowProvides },
    attachTo: document.body,
  });
}

const vaultBtn = (w: ReturnType<typeof mountRow>) => w.find(".item__vault-btn");

describe("the save button on a list the automatic capture already covers", () => {
  beforeEach(() => {
    vaultAuto.value = false;
    vaultDeclined.value = new Set();
    hasVault.value = true;
    vaultKnown.value = true;
    saveItemToVault.mockClear();
  });

  it("vanishes — no inline icon, no ⋯-menu entry — once the automatic path has the row", async () => {
    vaultAuto.value = true;
    const w = mountRow(gear());
    expect(vaultBtn(w).exists()).toBe(false);
    // the ⋯ menu follows the same disclosure rule (it used to keep a disabled
    // "Already in My Gear" line)
    await w.find(".item__morebtn").trigger("click");
    const labels = w.findAll(".item__morelist .menu__item").map((b) => b.text());
    expect(labels.some((l) => l.includes("My Gear"))).toBe(false);
    w.unmount();
  });

  it("stays a live action for a row the chooser declined", async () => {
    vaultAuto.value = true;
    const item = gear();
    vaultDeclined.value = new Set([vaultNormKey(item.brand, item.name, item.variant)]);
    const w = mountRow(item);
    const btn = vaultBtn(w);
    expect(btn.exists()).toBe(true);
    expect(btn.attributes("aria-label")).toBe("Save to My Gear");
    // pressing it is the one way a declined row gets banked
    await btn.trigger("click");
    expect(saveItemToVault).toHaveBeenCalledOnce();
    w.unmount();
  });

  it("waits for the row to become gear — a new item carries no icon, finishing it brings one", async () => {
    // no weight and no catalog link — isVaultWorthy says "still a half-typed
    // thought". There is nothing to save, so there is no button to press; the
    // old always-there button's only outcome here was a toast telling you to
    // finish the row it sat on.
    const w = mountRow(gear({ unitWeightMg: 0 }));
    expect(vaultBtn(w).exists()).toBe(false);
    await w.find(".item__morebtn").trigger("click");
    const labels = w.findAll(".item__morelist .menu__item").map((b) => b.text());
    expect(labels.some((l) => l.includes("My Gear"))).toBe(false);

    // the weight lands → the row is gear → the button arrives (this is the beat
    // the reveal animation plays on)
    await w.setProps({ item: gear({ unitWeightMg: 539_000 }) });
    expect(vaultBtn(w).exists()).toBe(true);
    expect(vaultBtn(w).attributes("aria-label")).toBe("Save to My Gear");
    w.unmount();
  });

  it("does not render at all on a water row — inline or in the ⋯ menu", async () => {
    // water is never vault-worthy (isVaultWorthy → isWaterRow), so before this
    // rule the inline button's only possible outcome was the "give it a name and
    // a weight" toast — on a row that has both. The ⋯ menu already ruled water
    // out; the inline button now follows the same rule.
    vaultAuto.value = true; // covered or not, there is nothing to render
    const w = mountRow(gear({ name: "Water", brand: undefined, classification: "consumable" }));
    expect(vaultBtn(w).exists()).toBe(false);
    await w.find(".item__morebtn").trigger("click");
    const labels = w.findAll(".item__morelist .menu__item").map((b) => b.text());
    expect(labels.some((l) => l.includes("My Gear"))).toBe(false);
    w.unmount();
  });

  it("still offers itself signed out — there is no vault for the gear to already be in", () => {
    vaultAuto.value = true;
    hasVault.value = false;
    const w = mountRow(gear());
    expect(vaultBtn(w).exists()).toBe(true);
    w.unmount();
  });

  it("waits for the session before calling a covered row uncovered", async () => {
    // hasVault is false in TWO situations that have nothing in common: signed out,
    // and the moment before /api/auth/me answers. Reading them as one put the
    // button on every worthy row of a list you built for the length of that round
    // trip — gear that had been in My Gear for weeks, offering to be saved to it —
    // and left it there for good on a lookup that never resolved (offline, a 429,
    // a blip: refresh() leaves `loaded` false so a later call retries).
    vaultAuto.value = true;
    hasVault.value = false;
    vaultKnown.value = false; // /api/auth/me still in flight
    const w = mountRow(gear());
    expect(vaultBtn(w).exists()).toBe(false);

    // ...and the answer, when it lands, is what decides. Signed out really does
    // mean nothing was banked, so the button arrives.
    vaultKnown.value = true;
    await nextTick();
    expect(vaultBtn(w).exists()).toBe(true);
    w.unmount();
  });

  it("costs a signed-in visitor no flash — the answer lands and the row stays bare", async () => {
    vaultAuto.value = true;
    hasVault.value = false;
    vaultKnown.value = false;
    const w = mountRow(gear());
    expect(vaultBtn(w).exists()).toBe(false);

    hasVault.value = true; // the session resolves as signed in
    vaultKnown.value = true;
    await nextTick();
    expect(vaultBtn(w).exists()).toBe(false);
    w.unmount();
  });

  it("still banks a row by hand on an uncovered list, and says so", async () => {
    const w = mountRow(gear());
    const btn = vaultBtn(w);
    expect(btn.attributes("aria-label")).toBe("Save to My Gear");
    await btn.trigger("click");
    expect(saveItemToVault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(vaultBtn(w).attributes("aria-label")).toBe("Saved to My Gear"));
    w.unmount();
  });

  it("sits at the cluster's left edge, before the nesting menu", () => {
    // the trailing cluster is right-aligned, so the one icon that comes and goes
    // per row must sit at the OPEN edge — ahead of nesting — or its absence would
    // shuffle the constant icons from row to row
    const w = mountRow(gear());
    const btn = vaultBtn(w).element;
    const nest = w.find(".item__nest-btn").element;
    expect(btn.compareDocumentPosition(nest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    w.unmount();
  });
});
