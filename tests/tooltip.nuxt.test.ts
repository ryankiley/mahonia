// @vitest-environment nuxt
//
// The tooltip's POSITIONING logic — the only part of <Tooltip> that makes decisions.
// Needs the Nuxt environment for the same reason gearList.nuxt.test.ts does: the
// component leans on auto-imports (useTemplateRef, useId) and on a real DOM for the
// Teleport, and what's under test is geometry read off live rects, not a pure
// function that could be lifted out and checked as plain TS.
//
// happy-dom lays nothing out, so every rect is 0×0 unless told otherwise. The suite
// therefore drives layout from `geom` below — where the trigger sits, how big the
// popup measures, how wide the page column is — via one prototype stub that answers
// by class name. Each case sets its own geometry and asserts the placement +
// left/top the component computes from it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import Tooltip from "~/components/Tooltip.vue";

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
function mountTooltip(props: InstanceType<typeof Tooltip>["$props"], inWrap = true) {
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

// Hover and hand back the positioned popup (null if none was shown).
async function hover() {
  await wrapper!.trigger("mouseenter");
  await flushPromises();
  return document.body.querySelector<HTMLElement>(".tooltip");
}

describe("Tooltip positioning", () => {
  beforeEach(() => {
    // a 1200×800 viewport, and a pointer that can actually hover
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
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
    wrapper?.unmount();
    wrapper = undefined;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("prefers top, and centres the popup on the trigger", async () => {
    mountTooltip({ text: "Remove item" });
    const tip = (await hover())!;

    expect(tip.dataset.placement).toBe("top");
    // trigger centre 516 − half the 100px popup = 466
    expect(tip.style.left).toBe("466px");
    // 400 (trigger top) − 24 (popup height) − 8 (default offset)
    expect(tip.style.top).toBe("368px");
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

    await wrapper!.trigger("focusin");
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
