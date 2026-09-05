import type { Ref } from "vue";

/**
 * The travelling hover plate for `.menu__list` — ONE wash that moves between rows
 * instead of a background painted on each.
 *
 * Ported from the design system's ds-menu. The CSS half lives in
 * atoms/controls.scss (`.menu__plate`); this is the half that has to measure, and
 * three things about it are non-obvious enough to be worth stating:
 *
 *  • It reads `offsetTop`, NOT a rect delta. The menu's enter transition SCALES
 *    the card (see the motion block in controls.scss), so a getBoundingClientRect
 *    delta comes back in scaled pixels — and a translate applied inside that same
 *    scaled card scales a second time. The wash lands short of the row it's
 *    lighting, worse the further down the card you go. Layout space is immune.
 *
 *  • The FIRST placement is made silently. With nothing to travel from, the plate
 *    would fly in from the top of the card and grow out of nothing; `is-placing`
 *    kills the transition, a forced reflow flushes that, then it comes back off.
 *    It's a class rather than an inline style so the transition itself stays in the
 *    stylesheet — and it is set through `classList`, NOT through a reactive flag
 *    the template binds. That is the whole reason this ever worked or didn't: a ref
 *    toggled true and then false inside one handler is coalesced into no change at
 *    all by the time Vue's queue flushes, and `void plate.offsetHeight` flushes
 *    LAYOUT, not that queue. The class never reached the DOM and every first hover
 *    flew in from the top of the card, which is exactly what the paragraph above
 *    says it doesn't. Anything the plate needs mid-gesture is set on the element.
 *
 *  • A move that CROSSES A RULE is a hand-off, not a slide. See below.
 *
 * It follows FOCUS as well as the pointer, deliberately: a menu whose only
 * "you are here" mark is reserved for people with a mouse works worse the more you
 * rely on the keyboard.
 *
 * Usage — two things in the consuming component:
 *   const { plateRef, listRef, on } = useMenuPlate();
 *   <ul ref="listRef" v-on="on"> <span ref="plateRef" class="menu__plate" /> …
 * Rows are identified by `[data-row]`, so an item that shouldn't light (a separator,
 * a heading that is only a label) simply doesn't carry it. A section HEADER does
 * carry it: it is a button that opens something, and once a menu has a plate the
 * rows' own :hover is switched off (controls.scss), so a header left unmarked lights
 * on neither path and reads as dead.
 */
export function useMenuPlate(): {
  plateRef: Ref<HTMLElement | null>;
  listRef: Ref<HTMLElement | null>;
  on: {
    pointerover: (e: PointerEvent) => void;
    pointerleave: () => void;
    focusin: (e: FocusEvent) => void;
    focusout: (e: FocusEvent) => void;
  };
} {
  const plateRef = ref<HTMLElement | null>(null);
  const listRef = ref<HTMLElement | null>(null);

  // Which GROUP the plate is standing in, while it is lit. A group is the nearest
  // ancestor marked [data-row-group] — the <li> a menu rules off from the rest —
  // and everything not inside one belongs to the list itself.
  let group: Element | null = null;

  function hide() {
    plateRef.value?.classList.remove("is-on");
    group = null;
  }

  // One listener per plate ELEMENT, wired the first time that element crosses. The
  // crossing class carries a timing an ordinary travel mustn't inherit, so it comes
  // off when the animation ends; the menu's v-if mints a new span each time it
  // opens, and the listener dies with the old one.
  let wired: HTMLElement | null = null;
  function wireCross(plate: HTMLElement) {
    if (wired === plate) return;
    wired = plate;
    plate.addEventListener("animationend", () => plate.classList.remove("is-crossing"));
  }

  function moveTo(row: HTMLElement | null) {
    const plate = plateRef.value;
    const list = listRef.value;
    if (!plate || !list) return;
    // A row belongs to this plate only if it's inside THIS list. Anything else
    // hides the plate rather than being ignored — leaving is leaving, and a plate
    // parked on the last row you touched while the pointer is elsewhere reads as a
    // second selection.
    if (!row || !list.contains(row) || (row as HTMLButtonElement).disabled) return hide();

    const first = !plate.classList.contains("is-on");
    const to = row.closest("[data-row-group]") ?? list;
    // A HAIRLINE IN A MENU SEPARATES TWO KINDS OF THING — the kebab's delete, the
    // read menu's report, ListMenu's "New list" — and the wash's whole premise is
    // one thing being pointed along a run of PEERS. Between kinds there is no run,
    // so it leaves one group and arrives in the other instead of gliding over the
    // rule as though the rows below were more of the rows above. The motion is in
    // the stylesheet (`.menu__plate.is-crossing`); this only says when.
    //
    // ListMenu already reads this way, for a structural reason rather than a chosen
    // one — its footer sits outside the scroller and carries its own plate — so this
    // is every other menu agreeing with the one that had no choice.
    const crossing = !first && to !== group;
    group = to;

    // Off first, and unconditionally: re-adding a class the element already carries
    // does NOT restart its animation, so a pointer sweeping down through two rules
    // in a row would hand off once and then just slide. Removing it and forcing a
    // reflow is what makes the second one replay.
    plate.classList.remove("is-crossing");
    if (first) {
      plate.classList.add("is-placing");
    } else if (crossing) {
      void plate.offsetHeight;
      plate.classList.add("is-crossing");
      wireCross(plate);
    }

    // measured against the plate's own offsetParent, which is the list; a row
    // nested in an <li> still reports its position in that same space
    plate.style.transform = `translateY(${row.offsetTop}px)`;
    plate.style.height = `${row.offsetHeight}px`;
    // THE PLATE CARRIES THE ROW'S OWN HUE, so a destructive row lights red rather
    // than in the neutral wash — a grey fill under red text says "a row", and the
    // point of the colour is that this row isn't one.
    //
    // OPT-IN, via [data-row-hue] — the same way [data-row] already says which
    // elements the plate may land on at all. The design system's ds-menu takes every
    // row's colour unconditionally, which is right there and wrong here: Mahonia's
    // rows already vary their ink for HIERARCHY (a section item and the switcher's
    // "New list" sit at --ink-2), so washing from that would light those rows more
    // faintly than their neighbours — "less hoverable" rather than "different in
    // kind". Marking the one row that means it leaves every other menu untouched.
    //
    // The COLOUR comes from computed `color`, which is resolved — light-dark()
    // picked, var() substituted. A custom property would hand over its raw token
    // stream instead, and the row's own declaration is the honest single source for
    // "this row's ink" anyway.
    if (row.hasAttribute("data-row-hue")) {
      plate.style.setProperty("--hov-ink", getComputedStyle(row).color);
    } else {
      plate.style.removeProperty("--hov-ink");
    }
    if (first) {
      void plate.offsetHeight; // flush, so the placement can't be animated
      plate.classList.remove("is-placing");
    }
    plate.classList.add("is-on");
  }

  const rowFrom = (t: EventTarget | null) =>
    t instanceof Element ? t.closest<HTMLElement>("[data-row]") : null;

  return {
    plateRef,
    listRef,
    on: {
      pointerover: (e: PointerEvent) => moveTo(rowFrom(e.target)),
      pointerleave: hide,
      focusin: (e: FocusEvent) => moveTo(rowFrom(e.target)),
      focusout: (e: FocusEvent) => {
        if (!listRef.value?.contains(e.relatedTarget as Node)) hide();
      },
    },
  };
}
