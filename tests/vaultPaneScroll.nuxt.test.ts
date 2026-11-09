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
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
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

// The pane's three collaborators, stubbed to the surface it actually touches. The
// real ones would drag in the local-list store, a sync poll and four endpoints —
// none of which has any say in what a finger on the sheet does.
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  vaultFetch: async () => ({ items: Array.from({ length: rowCount }, (_, i) => entry(i + 1)) }),
}));
// one instance across calls, so a case can see what the pane added
const addVaultItem = vi.fn();
mockNuxtImport("useGearList", () => () => ({
  snapshot: ref({ folders: [], items: [], displayUnit: "g" }),
  addVaultItem,
  moveItem: vi.fn(),
  // What My Gear holds of this list's gear, and which keys have an answer at all
  // — ItemRow renders its save button against these. Empty-but-answered here:
  // these suites are not about the vault, and a row that has been asked about and
  // isn't banked is the plainest state to render.
  vaultGear: ref(new Map()),
  vaultGearAsked: ref(new Set()),
  vaultGearSettled: ref(true),
}));
// dragId is the live-drag flag the touch guard reads (a non-null id = a drag in flight)
const dragId = ref<string | null>(null);
const startInsert = vi.fn();
mockNuxtImport("useItemDnd", () => () => ({ startInsert, dragId }));

let wrapper: ReturnType<typeof mount> | undefined;

// the pane hangs an Escape listener on window; unmounting takes it with it
enableAutoUnmount(afterEach);

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
    dragId.value = null;
  });
  afterEach(() => {
    document.body.innerHTML = ""; // the cases append raw nodes beside the mount
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
});

// A ROW BEING CARRIED IS NEVER A SCROLL. The report: dragging a row out of the phone
// sheet died on the first move. The guard above hands a move to the browser whenever the
// rows can still travel that way — right for a swipe, fatal for a drag, because a touch
// scroll steals the pointer (pointercancel) and the drag is gone. Once the row's hold has
// armed, or the drag it became is live, the guard swallows every move.
describe("a held row on the vault sheet", () => {
  beforeEach(() => {
    rowCount = 30;
    dragId.value = null;
    startInsert.mockClear();
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  /** Event timestamps, pinned: the hold rule compares them (see pointerDrag's tests). */
  const at = <E extends Event>(ev: E, t: number): E => {
    Object.defineProperty(ev, "timeStamp", { value: t });
    return ev;
  };
  /** A finger down on the first row at time t. */
  function press(list: HTMLElement, t: number) {
    const row = list.querySelector<HTMLElement>(".vp__add")!;
    row.dispatchEvent(
      at(new PointerEvent("pointerdown", { pointerId: 1, pointerType: "touch", button: 0, clientX: 40, clientY: 500, bubbles: true }), t),
    );
    return row;
  }
  /** The same finger's next touchmove at time t; true when the sheet kept it from the browser. */
  function moveAt(target: Element, t: number, dy = -120): boolean {
    const send = (type: string, y: number, time: number) => {
      const ev = at(new Event(type, { bubbles: true, cancelable: true }), time);
      Object.defineProperty(ev, "touches", { value: [{ clientY: y } as Touch] });
      target.dispatchEvent(ev);
      return ev;
    };
    send("touchstart", 500, t - 1);
    return send("touchmove", 500 + dy, t).defaultPrevented;
  }

  it("swallows the move once the hold has armed, though the rows could scroll", async () => {
    const { list } = await openPane();
    fakeScroll(list!, { scrollTop: 0, range: 800 });
    const row = press(list!, 1000);
    expect(moveAt(row, 1300)).toBe(true);
  });

  it("still hands the rows a swipe that starts before the hold", async () => {
    const { list } = await openPane();
    fakeScroll(list!, { scrollTop: 0, range: 800 });
    const row = press(list!, 1000);
    expect(moveAt(row, 1100)).toBe(false);
  });

  it("swallows every move while the drag it became is live", async () => {
    const { list } = await openPane();
    fakeScroll(list!, { scrollTop: 300, range: 800 });
    dragId.value = " insert";
    expect(moveAt(list!, 5000, 120)).toBe(true);
  });

  it("lifts the row and ticks the phone when the hold takes, and sets it down after", async () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    const { list } = await openPane();
    vi.useFakeTimers();
    const row = press(list!, performance.now());
    vi.advanceTimersByTime(250);
    await nextTick();
    expect(row.classList.contains("is-lifted")).toBe(true);
    expect(vibrate).toHaveBeenCalledWith(10);
    // lifted without moving: a tap after all, so the row comes back down
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    await nextTick();
    expect(row.classList.contains("is-lifted")).toBe(false);
  });
});

// A press that became a drag swallows the click its pointerup may trail, so the row
// isn't added twice. The drag holds the pointer on <html>, though, so that click often
// never reaches the row — and the swallow then ate the next REAL click on it.
describe("a row's click after a drag that didn't add it", () => {
  beforeEach(() => {
    rowCount = 2;
    dragId.value = null;
    startInsert.mockClear();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("adds the row on the next click, once the drag is over", async () => {
    const { list } = await openPane();
    const add = addVaultItem;
    add.mockClear();
    const row = list!.querySelector<HTMLElement>(".vp__add")!;
    const pointer = (type: string, x: number) =>
      new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: 100, bubbles: true });

    // a mouse drag off the row, let go over nothing: no drop, and no click on the row
    row.dispatchEvent(pointer("pointerdown", 40));
    window.dispatchEvent(pointer("pointermove", 80));
    expect(startInsert).toHaveBeenCalledTimes(1);
    window.dispatchEvent(pointer("pointerup", 80));

    // then an ordinary click on the same row
    row.dispatchEvent(pointer("pointerdown", 40));
    window.dispatchEvent(pointer("pointerup", 40));
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("still swallows the click that trails the drag itself", async () => {
    const { list } = await openPane();
    const add = addVaultItem;
    add.mockClear();
    const row = list!.querySelector<HTMLElement>(".vp__add")!;
    const pointer = (type: string, x: number) =>
      new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: 100, bubbles: true });
    row.dispatchEvent(pointer("pointerdown", 40));
    window.dispatchEvent(pointer("pointermove", 80));
    window.dispatchEvent(pointer("pointerup", 80));
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(add).not.toHaveBeenCalled();
  });
});

describe("the vault sheet's rows", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  // the name truncates on a phone; the full one is a hover away on a desktop
  it("give each gear name its full name as a title", async () => {
    rowCount = 2;
    const { pane } = await openPane();
    const names = [...pane.querySelectorAll(".vp__list .gear__name")].map((n) => n.getAttribute("title"));
    expect(names).toEqual(["Brand Item 1", "Brand Item 2"]);
  });
});

// The sheet focuses its search on open, which raises the keyboard over a sheet pinned to
// the bottom of the screen. It lifts by the strip the keyboard covers (--kb) and caps its
// height to what's left (--sheet-room) — both read off the visual viewport, which only a
// phone has a real one of, so it's stubbed: an 844px layout viewport, keyboard covering
// the bottom 336, a 61px topbar.
describe("the vault sheet and the keyboard", () => {
  const listeners: Record<string, () => void> = {};
  const vv = {
    height: 844,
    offsetTop: 0,
    addEventListener: (type: string, fn: () => void) => void (listeners[type] = fn),
    removeEventListener: vi.fn(),
  };
  beforeEach(() => {
    rowCount = 2;
    vv.height = 844;
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    const bar = document.createElement("header");
    bar.className = "topbar";
    bar.getBoundingClientRect = (() => ({ top: 0, bottom: 61 })) as never;
    document.body.appendChild(bar);
  });
  afterEach(() => {
    document.body.innerHTML = "";
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
  });

  // the <aside> itself — the mount's root element is a wrapper around the pane
  const sheet = () => document.querySelector<HTMLElement>("[data-vault-pane]")!;

  it("sits where it always did with no keyboard", async () => {
    await openPane();
    expect(sheet().style.getPropertyValue("--kb")).toBe("0px");
    expect(sheet().style.getPropertyValue("--sheet-room")).toBe(`${844 - 61}px`);
  });

  it("lifts by the keyboard's height when it rises, and shrinks to the room left", async () => {
    await openPane();
    vv.height = 508;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => (cb(0), 1));
    try {
      listeners.resize!();
      await nextTick();
      expect(sheet().style.getPropertyValue("--kb")).toBe("336px");
      expect(sheet().style.getPropertyValue("--sheet-room")).toBe(`${508 - 61}px`);
    } finally {
      raf.mockRestore();
    }
  });
});
