// @vitest-environment nuxt
//
// The side panel's touch guard — which gesture the sheet keeps and which it hands
// to the browser. The guard moved from VaultPane to SidePanel when the lists nav and
// the vault became two tabs of one surface: it has to answer swipes on the panel's
// own chrome as well as on the rows, and that chrome is the shell's. It finds the
// scroller by `[data-panel-scroller]`, so it covers whichever tab is showing; these
// cases drive it through the vault tab, which is the only one a phone ever sees.
//
// On a phone the panel is a bottom sheet floating over the list, and
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
import SidePanel from "~/components/SidePanel.vue";
import VaultBrowser from "~/components/VaultBrowser.vue";

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

// The pane's three collaborators, stubbed to the surface it actually touches. The
// real ones would drag in the local-list store, a sync poll and four endpoints —
// none of which has any say in what a finger on the sheet does.
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  vaultFetch: async () => ({ items: Array.from({ length: rowCount }, (_, i) => entry(i + 1)) }),
}));
mockNuxtImport("useGearList", () => () => ({
  snapshot: ref({ folders: [], items: [], displayUnit: "g" }),
  addVaultItem: vi.fn(),
  moveItem: vi.fn(),
}));
mockNuxtImport("useItemDnd", () => () => ({ startInsert: vi.fn() }));

let wrapper: ReturnType<typeof mount> | undefined;

/**
 * Mount the panel open on its vault tab with the gear loaded, and hand back its
 * root + row list.
 *
 * `LazyVaultBrowser` is a Nuxt auto-import, resolved by the app's component
 * registry — which a bare mount() of one component doesn't set up, so the tab body
 * silently rendered as nothing and every row case failed on a null list. Handing
 * the REAL browser in under that name keeps the test honest (real rows, real
 * scroller) while skipping a resolution step that isn't what's under test.
 */
async function openPane() {
  wrapper = mount(SidePanel, {
    props: { width: 368, open: true, tab: "vault", currentShareCode: null },
    global: { components: { LazyVaultBrowser: VaultBrowser } },
    attachTo: document.body,
  });
  await flushPromises();
  await nextTick();
  const pane = wrapper.element as HTMLElement;
  return { pane, list: pane.querySelector<HTMLElement>("[data-panel-scroller]") };
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

describe("the side panel sheet's touch guard", () => {
  beforeEach(() => {
    rowCount = 30;
  });
  // the pane hangs an Escape listener on window; unmounting takes it with it
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    document.body.innerHTML = "";
  });

  it("swallows a swipe on the header, which has nothing to scroll", async () => {
    const { pane } = await openPane();
    expect(swipe(pane.querySelector(".sp__head")!, -120)).toBe(true);
  });

  it("swallows a swipe on the search row", async () => {
    const { pane } = await openPane();
    expect(swipe(pane.querySelector(".vp__search")!, -120)).toBe(true);
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
    expect(swipe(pane.querySelector(".sp__head")!, -120, 2)).toBe(false);
  });
});
