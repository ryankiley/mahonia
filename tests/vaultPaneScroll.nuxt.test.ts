// @vitest-environment nuxt
//
// The vault pane's touch guard — which gesture the sheet keeps and which it hands
// to the browser. On a phone the pane is a bottom sheet floating over the list, and
// a fixed box's scroll chain runs straight to the viewport, so anything the sheet
// doesn't answer for itself scrolls the PAGE behind it. The regression this pins is
// exactly that: swiping the sheet's header, its search row, or a row list too short
// to scroll used to move the list underneath.
//
// happy-dom lays nothing out, so scrollHeight/clientHeight read 0 on every element
// and a real scroll can't happen here. Both are stubbed per case, the same way
// pointerDrag.nuxt.test.ts stubs elementFromPoint: the guard's decision is ABOUT
// those readings, so faking them is faking the input, not the logic. What's asserted
// is the one thing that decides the outcome in a browser — whether the touchmove was
// cancelled.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import VaultPane from "~/components/VaultPane.vue";

const entry = (id: number) => ({
  id,
  brand: "Brand",
  name: `Item ${id}`,
  variant: null,
  weightMg: 100_000,
  normKey: `brand|item ${id}|`,
});

// How many rows /api/vault/list hands back. Set per case: a long list is the
// scrolling one, two rows is the list with nothing to scroll.
let rowCount = 30;
let rowStart = 1;
const hasVault = ref(true);
const accountGeneration = ref(0);
let deferLoad = false;
let settleLoads: Array<() => void> = [];

// The pane's three collaborators, stubbed to the surface it actually touches. The
// real ones would drag in the local-list store, a sync poll and four endpoints —
// none of which has any say in what a finger on the sheet does.
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault,
  accountGeneration,
  vaultFetch: async () => {
    // Freeze this request's rows before waiting so the lifetime test can tell an
    // old account's late response from the current account's fresh one.
    const response = { items: Array.from({ length: rowCount }, (_, i) => entry(rowStart + i)) };
    if (deferLoad) await new Promise<void>((resolve) => settleLoads.push(resolve));
    return response;
  },
}));
mockNuxtImport("useGearList", () => () => ({
  snapshot: ref({ folders: [], items: [], displayUnit: "g" }),
  addVaultItem: vi.fn(),
  moveItem: vi.fn(),
  // What My Gear holds of this list's gear, and which keys have an answer at all
  // — ItemRow renders its save button against these. Empty-but-answered here:
  // these suites are not about the vault, and a row that has been asked about and
  // isn't banked is the plainest state to render.
  vaultGear: ref(new Map()),
  vaultGearAsked: ref(new Set()),
  vaultGearSettled: ref(true),
}));
mockNuxtImport("useItemDnd", () => () => ({ startInsert: vi.fn() }));

let wrapper: ReturnType<typeof mount> | undefined;

/** Mount the pane with its gear loaded, and hand back its root + row list. */
async function openPane() {
  wrapper = mount(VaultPane, { props: { width: 368 }, attachTo: document.body });
  await flushPromises();
  await nextTick();
  const pane = wrapper.element as HTMLElement;
  return { pane, list: pane.querySelector<HTMLElement>(".vp__list") };
}

/** Give an element a scroll range happy-dom would otherwise report as zero. */
function fakeScroll(el: HTMLElement, { scrollTop = 0, range = 0 }) {
  Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: 400 + range, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: scrollTop, writable: true, configurable: true });
}

/**
 * Put `fingers` down on `from`, then drag `dy` px (negative = up the screen, which
 * scrolls toward the end of a list). True when the sheet swallowed the move —
 * i.e. the page behind it would have stayed put.
 */
function swipe(from: Element, dy: number, fingers = 1): boolean {
  const at = (y: number) =>
    Array.from({ length: fingers }, () => ({ clientY: y }) as Touch);
  // happy-dom has no TouchEvent constructor; the guard reads `touches`, `target`,
  // `cancelable` and calls preventDefault, all of which a plain Event carries once
  // the touch points are attached.
  const send = (type: string, y: number) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "touches", { value: at(y) });
    from.dispatchEvent(ev);
    return ev;
  };
  send("touchstart", 500);
  return send("touchmove", 500 + dy).defaultPrevented;
}

describe("the vault sheet's touch guard", () => {
  beforeEach(() => {
    rowCount = 30;
    rowStart = 1;
    hasVault.value = true;
    accountGeneration.value = 0;
    deferLoad = false;
    settleLoads = [];
  });
  // the pane hangs an Escape listener on window; unmounting takes it with it
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    document.body.innerHTML = "";
    for (const settleLoad of settleLoads) settleLoad();
    settleLoads = [];
  });

  it("swallows a swipe on the header, which has nothing to scroll", async () => {
    const { pane } = await openPane();
    expect(swipe(pane.querySelector(".vp__head")!, -120)).toBe(true);
  });

  it("swallows a swipe on the search row", async () => {
    const { pane } = await openPane();
    expect(swipe(pane.querySelector(".sf__input")!, -120)).toBe(true);
  });

  it("hands the rows a swipe they can still travel", async () => {
    const { list } = await openPane();
    fakeScroll(list!, { scrollTop: 0, range: 800 });
    expect(swipe(list!, -120)).toBe(false);
  });

  it("hands the rows a swipe back toward their top", async () => {
    const { list } = await openPane();
    fakeScroll(list!, { scrollTop: 300, range: 800 });
    expect(swipe(list!, 120)).toBe(false);
  });

  it("swallows a swipe past the last row rather than chaining to the page", async () => {
    const { list } = await openPane();
    fakeScroll(list!, { scrollTop: 800, range: 800 });
    expect(swipe(list!, -120)).toBe(true);
  });

  it("swallows a swipe above the first row", async () => {
    const { list } = await openPane();
    fakeScroll(list!, { scrollTop: 0, range: 800 });
    expect(swipe(list!, 120)).toBe(true);
  });

  // The case overscroll-behavior can't reach: with nothing to scroll the rows are
  // never in the chain at all, so the gesture went straight to the viewport.
  it("swallows a swipe on a row list too short to scroll", async () => {
    rowCount = 2;
    const { list } = await openPane();
    fakeScroll(list!, { scrollTop: 0, range: 0 });
    expect(swipe(list!, -120)).toBe(true);
  });

  // Cancelling a two-finger move would take pinch-zoom with it.
  it("leaves a two-finger gesture alone", async () => {
    const { pane } = await openPane();
    expect(swipe(pane.querySelector(".vp__head")!, -120, 2)).toBe(false);
  });

  it("keeps a late old-account load out of a newly signed-in pane", async () => {
    rowCount = 1;
    rowStart = 1;
    deferLoad = true;
    const { pane } = await openPane();
    expect(settleLoads).toHaveLength(1);

    rowStart = 100;
    // B still has a vault; only the account lifetime changes.
    accountGeneration.value++;
    await flushPromises();
    await nextTick();
    expect(settleLoads).toHaveLength(2);

    settleLoads[0]!();
    await flushPromises();
    await nextTick();
    expect(pane.textContent).not.toContain("Item 1");
    expect(pane.querySelectorAll(".vp__add")).toHaveLength(0);

    settleLoads[1]!();
    await flushPromises();
    await nextTick();
    expect(pane.textContent).toContain("Item 100");
    expect(pane.querySelectorAll(".vp__add")).toHaveLength(1);
  });
});
