// The tooltip's two sets of decisions: POSITIONING (where the popup lands, and the
// point it scales out of) and the WARM-UP (when it waits, and when it opens at once
// without animating). Needs the Nuxt environment for the same reason
// gearList.nuxt.test.ts does: the component leans on auto-imports (useTemplateRef,
// useId) and on a real DOM for the Teleport, and what's under test is geometry read off
// live rects and timing read off a (fake) clock, not a pure function that could be
// lifted out and checked as plain TS.
//
// happy-dom lays nothing out, so every rect is 0×0 unless told otherwise. The suite
// therefore drives layout from `geom` below — where the trigger sits, how big the
// popup measures, how wide the page column is — via one prototype stub that answers
// by class name. Each case sets its own geometry and asserts the placement +
// left/top the component computes from it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import Tooltip from "~/components/Tooltip.vue";

enableAutoUnmount(afterEach);

type Rect = { top: number; bottom: number; left: number; right: number; width: number; height: number };
const rect = (r: Partial<Rect>): DOMRect =>
  ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}), ...r }) as DOMRect;

// The three boxes the component measures. `wrap` is the page column it clamps to —
// the real `.wrap` (main.scss) is a centred max-width block with a --space-4 gutter,
// so the host below carries a matching 16px padding-inline for getComputedStyle.
const geom = {
  trigger: {} as Partial<Rect>,
  tooltip: {} as Partial<Rect>,
  wrap: {} as Partial<Rect>,
};

let wrapper: ReturnType<typeof mount> | undefined;

// Mount inside a page column (or, with `inWrap: false`, floating outside any).
function mountTooltip(
  props: InstanceType<typeof Tooltip>["$props"],
  inWrap = true,
) {
  const host = document.createElement("div");
  if (inWrap) {
    host.className = "wrap";
    // longhands, not the `padding-inline` shorthand the real .wrap uses: happy-dom's
    // getComputedStyle doesn't expand logical shorthands (a browser does), and the
    // component reads paddingInlineStart/End off the computed style
    host.style.paddingInlineStart = "16px";
    host.style.paddingInlineEnd = "16px";
  }
  document.body.appendChild(host);
  wrapper = mount(Tooltip, { props, slots: { default: "<button>hover me</button>" }, attachTo: host });
  return wrapper;
}

// The first hover waits this long before the popup opens (Tooltip.vue, WARM-UP), and
// a popup closed less than WARM_MS ago makes the next one instant. Restated rather
// than imported: the component's module script doesn't export them, and the numbers are
// part of what's under test.
const HOVER_DELAY = 400;
const WARM_MS = 300;

// Hover, wait out the delay, and hand back the positioned popup (null if none was shown).
async function hover() {
  await wrapper!.trigger("mouseenter");
  vi.advanceTimersByTime(HOVER_DELAY);
  await flushPromises();
  return document.body.querySelector<HTMLElement>(".tooltip");
}

// The hover's wait is a timer and the warm-up reads Date.now(); both run on the fake
// clock. Each case starts its clock an hour past the last one's start, so every case
// begins cold whatever the one before it left open or closed — the warm-up is module
// state, shared by every instance on the page and so by every case in this file. (Not
// "advance from now": a fresh fake clock starts at the REAL time, which is behind a
// close the previous case stamped after advancing its own.)
let clock = Date.now();
beforeEach(() => {
  vi.useFakeTimers({ now: (clock += 3_600_000) });
  // a 1200×800 viewport, and a pointer that can actually hover
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  // the horizontal clamp reads the LAYOUT viewport (no scrollbar column), not innerWidth
  Object.defineProperty(document.documentElement, "clientWidth", { value: 1200, configurable: true });
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q }) as MediaQueryList);

  geom.trigger = { top: 400, bottom: 424, left: 500, width: 32, height: 24 };
  geom.tooltip = { width: 100, height: 24 };
  geom.wrap = { left: 100, right: 1100 };

  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.classList.contains("tooltip-trigger")) return rect(geom.trigger);
    if (this.classList.contains("wrap")) return rect(geom.wrap);
    return rect({});
  });
  // The popup is sized off offsetWidth/Height, not a client rect — see the comment
  // in positionTooltip(): it's measured while the enter transform is still applied,
  // so only the untransformed layout box gives the true size.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("tooltip") ? (geom.tooltip.width ?? 0) : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("tooltip") ? (geom.tooltip.height ?? 0) : 0;
  });
});

afterEach(() => {
  document.body.innerHTML = ""; // the cases append raw nodes beside the mount
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Tooltip positioning", () => {
  it("prefers top, and centres the popup on the trigger", async () => {
    mountTooltip({ text: "Remove item" });
    const tip = (await hover())!;

    expect(tip.dataset.placement).toBe("top");
    // trigger centre 516 − half the 100px popup = 466
    expect(tip.style.left).toBe("466px");
    // 400 (trigger top) − 24 (popup height) − 8 (default offset)
    expect(tip.style.top).toBe("368px");
  });

  // A control may put its glyph to one side of its tap target rather than in the
  // middle — the editor's row actions right-align every glyph so the drag grip sits
  // flush at the row's edge. Centred on the BOX, the popup then points at the padding
  // beside the picture it names; measured on a real row, 8px left of a 16px glyph in a
  // 32px button, which reads as a broken tooltip rather than a deliberate one.
  it("centres on the trigger's ink when --tip-shift moves it off the box centre", async () => {
    const w = mountTooltip({ text: "Remove" });
    // the glyph sits 8px right of the button's centre
    w.element.style.setProperty("--tip-shift", "8px");
    const tip = (await hover())!;

    // trigger centre 516, ink centre 524, − half the 100px popup = 474
    expect(tip.style.left).toBe("474px");
  });

  it("leaves an unshifted trigger exactly where it was", async () => {
    // the property is absent on every other trigger in the app, and an absent custom
    // property reads back as "" — which must mean 0 and not NaN
    mountTooltip({ text: "Remove" });
    const tip = (await hover())!;
    expect(tip.style.left).toBe("466px");
  });

  it("flips to bottom when the space above can't hold it", async () => {
    // 20px from the top: 24 (popup) + 8 (offset) + 12 (edge padding) doesn't fit
    geom.trigger = { top: 20, bottom: 44, left: 500, width: 32, height: 24 };
    mountTooltip({ text: "Collapse folder" });
    const tip = (await hover())!;

    expect(tip.dataset.placement).toBe("bottom");
    expect(tip.style.top).toBe("52px"); // trigger bottom 44 + 8
  });

  it("flips a bottom-preferred tooltip back to top near the viewport floor", async () => {
    geom.trigger = { top: 760, bottom: 784, left: 500, width: 32, height: 24 };
    mountTooltip({ text: "Drag to reorder", preferredPlacement: "bottom" });
    const tip = (await hover())!;

    expect(tip.dataset.placement).toBe("top");
    expect(tip.style.top).toBe("728px"); // 760 − 24 − 8
  });

  it("clamps to the page column's content edges, not the viewport", async () => {
    // column runs 100…1100 with a 16px gutter → content edges 116 and 1084. The
    // trigger is an action icon hard against the column's right edge.
    geom.trigger = { top: 400, bottom: 424, left: 1052, width: 32, height: 24 };
    geom.tooltip = { width: 160, height: 24 };
    mountTooltip({ text: "Un-nest (move out)" });
    const tip = (await hover())!;

    // centred would be 988; clamped to 1084 − 160 = 924, still well inside the
    // viewport — which is the point of clamping to the column rather than the window
    expect(tip.style.left).toBe("924px");
  });

  it("falls back to a viewport clamp outside any page column", async () => {
    geom.trigger = { top: 400, bottom: 424, left: 0, width: 32, height: 24 };
    geom.tooltip = { width: 160, height: 24 };
    mountTooltip({ text: "Copy read-only link" }, false);
    const tip = (await hover())!;

    // centred would be −64; clamped to the 12px viewport buffer
    expect(tip.style.left).toBe("12px");
  });

  it("shows nothing on a touch-only device", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(hover: none)", media: q }) as MediaQueryList);
    mountTooltip({ text: "Remove item" });

    expect(await hover()).toBeNull();
  });

  // The three ways a finger reaches a trigger, all of which used to raise one: the
  // emulated mouseenter a tap fires, the tap itself (which used to TOGGLE the popup),
  // and the focus a tap lands on the button underneath. Every tooltip in the app wraps
  // a control that already acts when pressed, so on a phone all three were describing
  // something the same tap had just done.
  it("raises nothing a touch can reach", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(hover: none)", media: q }) as MediaQueryList);
    mountTooltip({ text: "Remove item" });

    for (const ev of ["mouseenter", "click", "focusin"]) {
      await wrapper!.trigger(ev);
      await flushPromises();
      expect(document.body.querySelector(".tooltip"), `${ev} raised one`).toBeNull();
    }
  });

  // The reason focus reaches past hover at all: the planning view's (?) buttons explain
  // where an estimate came from, and a keyboard is exactly how someone who can't hover
  // gets to them. `hover: false` here is the ordinary desktop case, where the keyboard
  // test is skipped outright — a tablet-with-keyboard goes through :focus-visible, which
  // is the browser's own answer and not something this suite can meaningfully stub.
  it("still opens on focus where a pointer can hover", async () => {
    mountTooltip({ text: "Remove item" });

    // a real focus on the control (happy-dom's :focus-visible is "is the active
    // element"), so this is the keyboard's path: at once, with no wait to advance past
    wrapper!.find("button").element.focus();
    await flushPromises();
    expect(document.body.querySelector(".tooltip")).not.toBeNull();
  });

  it("dismisses on scroll — a fixed popup would otherwise detach from its anchor", async () => {
    mountTooltip({ text: "Remove item" });
    expect(await hover()).not.toBeNull();

    window.dispatchEvent(new Event("scroll"));
    await flushPromises();
    expect(document.body.querySelector(".tooltip")).toBeNull();
  });

  it("describes the trigger only while the tooltip is up", async () => {
    mountTooltip({ text: "Remove item" });
    const trigger = wrapper!.element as HTMLElement;
    expect(trigger.getAttribute("aria-describedby")).toBeNull();

    const tip = (await hover())!;
    expect(trigger.getAttribute("aria-describedby")).toBe(tip.id);

    await wrapper!.trigger("mouseleave");
    await flushPromises();
    expect(trigger.getAttribute("aria-describedby")).toBeNull();
  });
});

// THE WARM-UP — the next tooltip doesn't wait. The first tooltip waits
// before it opens, so a pointer crossing the toolbar on its way somewhere else raises
// nothing; once one has been up, the next one along opens at once and without its
// animation, because a pointer moving down a row of controls is reading them.
// `data-instant` is the attribute atoms/tooltip.scss zeroes the transition on.
describe("Tooltip warm-up", () => {
  // two triggers side by side, the way a toolbar has them
  function mountPair() {
    const host = document.createElement("div");
    host.className = "wrap";
    document.body.appendChild(host);
    const a = mount(Tooltip, { props: { text: "Duplicate" }, slots: { default: "<button>a</button>" }, attachTo: host });
    const b = mount(Tooltip, { props: { text: "Remove" }, slots: { default: "<button>b</button>" }, attachTo: host });
    return { a, b };
  }
  const tip = () => document.body.querySelector<HTMLElement>(".tooltip");

  it("waits before the first one opens", async () => {
    mountTooltip({ text: "Remove item" });
    await wrapper!.trigger("mouseenter");
    vi.advanceTimersByTime(HOVER_DELAY - 1);
    await flushPromises();
    expect(tip(), "opened before the wait was up").toBeNull();

    vi.advanceTimersByTime(1);
    await flushPromises();
    expect(tip()).not.toBeNull();
    // the first one is the one that animates
    expect(tip()!.hasAttribute("data-instant")).toBe(false);
  });

  it("raises nothing for a pointer that leaves before the wait is up", async () => {
    mountTooltip({ text: "Remove item" });
    await wrapper!.trigger("mouseenter");
    vi.advanceTimersByTime(HOVER_DELAY / 2);
    await wrapper!.trigger("mouseleave");
    vi.advanceTimersByTime(HOVER_DELAY);
    await flushPromises();
    expect(tip()).toBeNull();
  });

  it("opens the next one at once, and without animating, when it follows straight on", async () => {
    const { a, b } = mountPair();
    await a.trigger("mouseenter");
    vi.advanceTimersByTime(HOVER_DELAY);
    await flushPromises();
    expect(tip()!.textContent).toBe("Duplicate");

    // the pointer slides to the neighbour: leave one, enter the other
    await a.trigger("mouseleave");
    vi.advanceTimersByTime(WARM_MS / 3);
    await b.trigger("mouseenter");
    await flushPromises(); // no timer advanced: no wait at all
    expect(tip()!.textContent).toBe("Remove");
    expect(tip()!.hasAttribute("data-instant")).toBe(true);
  });

  it("goes cold again once the last one has been down a while", async () => {
    const { a, b } = mountPair();
    await a.trigger("mouseenter");
    vi.advanceTimersByTime(HOVER_DELAY);
    await flushPromises();
    await a.trigger("mouseleave");

    vi.advanceTimersByTime(WARM_MS);
    await b.trigger("mouseenter");
    await flushPromises();
    expect(tip(), "the wait was skipped after the warm window closed").toBeNull();
    vi.advanceTimersByTime(HOVER_DELAY);
    await flushPromises();
    expect(tip()!.textContent).toBe("Remove");
    expect(tip()!.hasAttribute("data-instant")).toBe(false);
  });

  it("is warm while another is still up", async () => {
    const { a, b } = mountPair();
    // keyboard focus holds A's open while the pointer arrives on B
    a.find("button").element.focus();
    await flushPromises();
    vi.advanceTimersByTime(WARM_MS * 10);
    await b.trigger("mouseenter");
    await flushPromises();
    const tips = [...document.body.querySelectorAll<HTMLElement>(".tooltip")].map((t) => t.textContent);
    expect(tips).toContain("Remove");
  });

  // Keyboard focus never waits and never animates: Tab is an action repeated in
  // bursts, and those get no animation at all.
  it("opens on keyboard focus at once and without animating, even cold", async () => {
    mountTooltip({ text: "Remove item" });
    wrapper!.find("button").element.focus();
    await flushPromises();
    expect(tip()).not.toBeNull();
    expect(tip()!.hasAttribute("data-instant")).toBe(true);
  });

  // A click focuses the button in Chromium without :focus-visible. That focus goes the
  // hover's way — it must not jump the wait the pointer is already serving.
  it("doesn't let a pointer focus skip the hover's wait", async () => {
    mountTooltip({ text: "Remove item" });
    await wrapper!.trigger("mouseenter");
    await wrapper!.trigger("focusin"); // dispatched on the wrapper: not the active element, so not :focus-visible
    await flushPromises();
    expect(tip()).toBeNull();
    vi.advanceTimersByTime(HOVER_DELAY);
    await flushPromises();
    expect(tip()).not.toBeNull();
  });

  it("scales out of the trigger's own x, not the popup's centre", async () => {
    // a trigger hard against the column's right edge: the clamp pushes the popup left,
    // so the trigger sits right of the popup's middle (see the clamp case above)
    geom.trigger = { top: 400, bottom: 424, left: 1052, width: 32, height: 24 };
    geom.tooltip = { width: 160, height: 24 };
    mountTooltip({ text: "Un-nest (move out)" });
    const t = (await hover())!;

    // popup clamped to left 924; the trigger's centre 1068 lands 144px into it
    expect(t.style.getPropertyValue("--tooltip-origin-x")).toBe("144px");
  });
});
