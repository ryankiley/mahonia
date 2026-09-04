// @vitest-environment nuxt
//
// The row's "Save to My Gear" button, which renders only while pressing it could
// do the thing it names. Three states hide it: a row that isn't yet gear (unnamed
// / unweighed — nothing to save), a row My Gear ALREADY HOLDS, and a row the
// automatic capture path is about to bank (the vault answer is yes). In all
// three, the button isn't dimmed, it's GONE: no inline icon, no ⋯-menu entry. A
// worthy row failing every covered gate keeps it as a live action, because
// pressing it is then the only way the row gets banked.
//
// The middle one is the gate this button spent three attempts without, and the
// reason it kept reappearing on gear banked months ago: coverage used to be
// inferred entirely from THIS LIST's capture answer, which is a different
// question and says no in every ordinary situation where the answer lives
// somewhere the device can't see it.
//
// Nuxt environment because the decision under test is what the ROW renders:
// whether the button exists at all, and whether a press reaches the controller.
// The condition spans the vault's own contents (useVaultKeys), the controller's
// mirror (vaultAuto / vaultDeclined), the session (hasVault), and the row's own
// worthiness — gearList.nuxt.test.ts proves the mirror tracks the stored answer;
// this file proves the row obeys both.
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
// having ANSWERED — false only in the moment before /api/auth/me lands;
// `vaultKeysKnown` is the same distinction one level down, for the read that says
// what My Gear actually holds.
const vaultAuto = ref(false);
const vaultDeclined = ref<Set<string>>(new Set());
const hasVault = ref(true);
const vaultKnown = ref(true);
const vaultKeys = ref<ReadonlySet<string>>(new Set<string>());
const vaultKeysKnown = ref(true);
const saveItemToVault = vi.fn(() => Promise.resolve("saved" as const));

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault,
  vaultKnown,
  vaultFetch: () => Promise.resolve({ results: [] }),
}));

mockNuxtImport("useVaultKeys", () => () => ({
  vaultKeys,
  vaultKeysKnown,
  refreshVaultKeys: () => Promise.resolve(),
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

const keyFor = (item: Item) => vaultNormKey(item.brand, item.name, item.variant);

describe("the save button, against what My Gear actually holds", () => {
  beforeEach(() => {
    vaultAuto.value = false;
    vaultDeclined.value = new Set();
    hasVault.value = true;
    vaultKnown.value = true;
    vaultKeys.value = new Set();
    vaultKeysKnown.value = true;
    saveItemToVault.mockClear();
  });

  it("stands down for gear the vault already holds, whatever this list's answer is", async () => {
    // THE BUG. Every route to it is the same shape: the gear is banked, and this
    // list's capture answer says otherwise — a list built on another device (the
    // answer is in that device's localStorage), a list answered "no", a list
    // whose prompt is still unanswered. The row used to take the answer's word
    // for it and offer to save a tent that had been in My Gear for months.
    const item = gear();
    vaultKeys.value = new Set([keyFor(item)]);
    const w = mountRow(item);
    expect(vaultBtn(w).exists()).toBe(false);
    // and the ⋯ menu agrees, on a phone where the inline cluster collapses
    await w.find(".item__morebtn").trigger("click");
    const labels = w.findAll(".item__morelist .menu__item").map((b) => b.text());
    expect(labels.some((l) => l.includes("My Gear"))).toBe(false);
    w.unmount();
  });

  it("still offers gear the vault does NOT hold, on that same uncovered list", () => {
    // the other half of the same rule — membership is per piece of gear, not per
    // list, so one banked row must not quiet its neighbours
    vaultKeys.value = new Set([vaultNormKey("Durston", "Kakwa 55", null)]);
    const w = mountRow(gear());
    expect(vaultBtn(w).exists()).toBe(true);
    expect(vaultBtn(w).attributes("aria-label")).toBe("Save to My Gear");
    w.unmount();
  });

  it("outranks a chooser exclusion — declining a row is not the same as not owning it", () => {
    // "that tent is my friend's, for THIS list" is an instruction to capture, and
    // it was read as a statement about the vault. Bank the same gear from
    // anywhere else and the button has nothing left to offer.
    vaultAuto.value = true;
    const item = gear();
    vaultDeclined.value = new Set([keyFor(item)]);
    vaultKeys.value = new Set([keyFor(item)]);
    const w = mountRow(item);
    expect(vaultBtn(w).exists()).toBe(false);
    w.unmount();
  });

  it("waits for the vault's answer before offering to save anything", async () => {
    // the flash PR #239 took out of the session lookup, one level down: an empty
    // key set means "we haven't asked" until the read lands, and rendering it as
    // "your vault is empty" would put the button back on every banked row for the
    // length of that round trip
    const item = gear();
    vaultKeysKnown.value = false;
    const w = mountRow(item);
    expect(vaultBtn(w).exists()).toBe(false);

    vaultKeys.value = new Set([keyFor(item)]);
    vaultKeysKnown.value = true;
    await nextTick();
    expect(vaultBtn(w).exists()).toBe(false); // banked all along; no flash
    w.unmount();
  });

  it("falls back to the list's answer when the vault can't be read at all", async () => {
    // offline, rate-limited, a blip: the read settles as known-with-nothing rather
    // than hiding a working affordance behind a request that may never land, so
    // the button lands exactly where it was before the read existed
    const w = mountRow(gear());
    expect(vaultBtn(w).exists()).toBe(true); // uncovered list → offered
    vaultAuto.value = true;
    await nextTick();
    expect(vaultBtn(w).exists()).toBe(false); // covered list → not
    w.unmount();
  });

  it("ignores a stale key set once the session says there is no vault", () => {
    // signing out drops the keys (resetVaultKeys), but the render must not depend
    // on that ordering: no vault means nothing is in one, whatever the set holds
    const item = gear();
    vaultKeys.value = new Set([keyFor(item)]);
    hasVault.value = false;
    const w = mountRow(item);
    expect(vaultBtn(w).exists()).toBe(true);
    w.unmount();
  });

  it("keeps its tick after a press, though banking the row is what covers it", async () => {
    // a press puts the key in the set immediately (useVault.captureOne →
    // noteVaultKeys), so a button that obeyed coverage alone would answer the
    // click by vanishing — which reads as the click having gone nowhere. The tick
    // IS the feedback, so it outranks coverage on the row that earned it.
    const item = gear();
    const w = mountRow(item);
    await vaultBtn(w).trigger("click");
    vaultKeys.value = new Set([keyFor(item)]); // what noteVaultKeys does
    await vi.waitFor(() => expect(vaultBtn(w).attributes("aria-label")).toBe("Saved to My Gear"));
    w.unmount();
  });

  it("takes the button back when the ticked row is renamed into different gear", async () => {
    // the tick stops speaking for a row whose identity changed — and the new
    // identity is judged on its own membership, like any other row
    const item = gear();
    const w = mountRow(item);
    await vaultBtn(w).trigger("click");
    vaultKeys.value = new Set([keyFor(item)]);
    await vi.waitFor(() => expect(vaultBtn(w).attributes("aria-label")).toBe("Saved to My Gear"));

    await w.setProps({ item: gear({ name: "Kakwa 55", brand: "Durston" }) });
    expect(vaultBtn(w).attributes("aria-label")).toBe("Save to My Gear");
    w.unmount();
  });
});

describe("the save button on a list the automatic capture already covers", () => {
  beforeEach(() => {
    vaultAuto.value = false;
    vaultDeclined.value = new Set();
    hasVault.value = true;
    vaultKnown.value = true;
    vaultKeys.value = new Set();
    vaultKeysKnown.value = true;
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
