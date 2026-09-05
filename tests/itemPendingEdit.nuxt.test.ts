// @vitest-environment nuxt
//
// A number you typed and then acted on WITHOUT leaving the field.
//
// Every control in an item row prevents its own mousedown default, so that clicking one
// out of a focused field can't blur the row and let discardEmpty take a pristine one out
// from under the click (the actions cluster's comment in ItemRow spells that out). The
// blur it suppresses is also what fires `change` — and `change` is where onQty and
// onWeight commit. So the commit never ran: the control re-rendered the row, the field
// repainted from a state that had never heard the number, and it was gone.
//
// Reported as the amount or the weight disappearing when a row is made consumable, which
// is the shortest path to it: type a weight into a new row, tap the cookie, watch the
// field empty itself. The hole was in the row's shared plumbing though, not in the
// classification toggles, so the cases below cover a second control (Worn) to pin that
// this is fixed once for the row rather than once per button.
//
// Needs the Nuxt environment: what's under test is an interaction between a real DOM
// focus, a real event dispatch and the component's own handlers — there is no pure
// function here to check instead.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { mount } from "@vue/test-utils";
import ItemRow, { CHILDREN_BY_PARENT, PEOPLE_CTX } from "~/components/ItemRow.vue";
import type { Item, ListSnapshot, Person } from "~~/shared/types";
import type { ItemPatch } from "~~/shared/ops";
import { applyOps } from "~~/shared/ops";
import { blankList } from "./helpers/list";

// what GearEditor provides to every row — the children map, and the people in
// display order with their slots (this list names nobody)
const rowProvides = {
  [CHILDREN_BY_PARENT as symbol]: ref(new Map<string, Item[]>()),
  [PEOPLE_CTX as symbol]: { sorted: ref<Person[]>([]), slotById: ref(new Map<string, number>()) },
};

registerEndpoint("/api/catalog/search", () => ({ results: [] }));
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(false),
  vaultKnown: ref(true),
  vaultFetch: () => Promise.resolve({ results: [] }),
}));

const weightCommits: string[] = [];
const snapshot = ref<ListSnapshot>(blankList());

mockNuxtImport("useGearList", () => () => ({
  pendingBlankId: ref<string | null>(null),
  updateItem: (id: string, patch: ItemPatch) => {
    snapshot.value = applyOps(snapshot.value, [{ t: "updateItem", id, patch }]) as ListSnapshot;
  },
  // the real one parses text → milligrams; recording the RAW string is what says whether
  // the commit path ran at all, which is the whole question here
  setItemWeight: (_id: string, raw: string) => weightCommits.push(raw),
  removeItem: () => {},
  duplicateItem: () => "",
  moveItem: () => {},
  discardEmpty: () => {},
  addBlankItemAfter: () => "",
  addChild: () => "",
  nestItem: () => {},
  unnest: () => {},
  saveItemToVault: () => Promise.resolve(),
  vaultAuto: ref(false),
  vaultDeclined: ref(new Set<string>()),
}));

// A row mid-build: named and counted, with NO weight yet. That's the state the report
// came from — an empty weight field means a dropped edit doesn't just revert, it vanishes.
const item: Item = {
  id: "i1",
  folderId: "f1",
  name: "Espresso beans",
  brand: null,
  unitWeightMg: 0,
  weightOverridden: false,
  qty: 3,
  classification: null,
  sortOrder: 0,
} as unknown as Item;

function mountRow() {
  snapshot.value = { ...blankList(), items: [{ ...item }] } as ListSnapshot;
  return mount(ItemRow, {
    props: {
      get list() {
        return snapshot.value;
      },
      get item() {
        return snapshot.value.items[0]!;
      },
    },
    global: { provide: rowProvides },
    attachTo: document.body,
  });
}

/** Type into a field the way a person does: focus it, change its value, commit nothing. */
function typeInto(el: HTMLInputElement, value: string) {
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const row = () => snapshot.value.items[0]!;

beforeEach(() => {
  weightCommits.length = 0;
  vi.restoreAllMocks();
});

describe("a pending number edit survives the row's own controls", () => {
  it("commits a typed weight when the Consumable toggle is pressed", async () => {
    const w = mountRow();
    const field = w.find<HTMLInputElement>('input[aria-label="Weight"]').element;
    typeInto(field, "250");
    expect(weightCommits).toEqual([]); // nothing committed yet — no blur has happened

    await w.find('button[aria-label^="Consumable"]').trigger("click");

    expect(weightCommits).toEqual(["250"]);
    w.unmount();
  });

  it("commits a typed quantity when the Consumable toggle is pressed", async () => {
    const w = mountRow();
    const field = w.find<HTMLInputElement>('input[aria-label="Quantity"]').element;
    typeInto(field, "7");

    await w.find('button[aria-label^="Consumable"]').trigger("click");

    expect(row().qty).toBe(7);
    w.unmount();
  });

  // the fix belongs to the row, not to one button
  it("commits a typed weight when the Worn toggle is pressed", async () => {
    const w = mountRow();
    const field = w.find<HTMLInputElement>('input[aria-label="Weight"]').element;
    typeInto(field, "250");

    await w.find('button[aria-label^="Worn"]').trigger("click");

    expect(weightCommits).toEqual(["250"]);
    w.unmount();
  });

  // Pressing INTO the field you are already editing must NOT commit: both handlers
  // resync the input from state afterwards, which mid-edit would drop the caret to the
  // end of the number you were part-way through fixing.
  //
  // Only the commit is asserted. Whether the typed text then survives on screen is the
  // uncontrolled input's own business, and happy-dom repaints one where a browser leaves
  // it alone — checked in a real Chromium instead, where the value stays "250" and the
  // caret stays where it was clicked rather than jumping to the end.
  it("does not commit when the press is on that same field", async () => {
    const w = mountRow();
    const field = w.find<HTMLInputElement>('input[aria-label="Weight"]');
    typeInto(field.element, "250");

    await field.trigger("click");

    expect(weightCommits).toEqual([]);
    w.unmount();
  });
});
