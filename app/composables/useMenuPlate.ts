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
 *  • A row may sit inside a SCROLLER that the plate is outside of, and the plate
 *    still travels to it — see `offsetIn` and `follow` below. One menu needs that
 *    (ListMenu, whose lists scroll inside a card whose footer doesn't), and it is
 *    the difference between the wash sliding across that card's hairline and
 *    blinking across it.
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
  // the row the plate is standing on, so a scroll under a still pointer can put it
  // back where that row went
  let at: HTMLElement | null = null;

  function hide() {
    plateRef.value?.classList.remove("is-on");
    at = null;
  }

  /**
   * Where a row sits in the plate's own coordinate space.
   *
   * Usually that is just its `offsetTop`: the plate is the list's first child, so
   * the two share an offsetParent. It stops being that the moment a menu puts some
   * of its rows in a SCROLLER — ListMenu's card scrolls its lists but deliberately
   * doesn't scroll "New list", so the plate has to sit outside the scroller to be
   * able to reach the footer at all, and a row inside one is then measured in a box
   * the plate isn't in. Walking the offsetParent chain up to the list, taking each
   * step's own offset and scroll as we go, puts both kinds of row in one space —
   * which is what lets the wash SLIDE from the last list across the hairline onto
   * "New list", the same move it makes between any other two rows.
   *
   * Still all layout-space reads, so the scaled-card trap above doesn't apply.
   */
  function offsetIn(row: HTMLElement, list: HTMLElement) {
    let y = row.offsetTop;
    for (let n = row.offsetParent; n instanceof HTMLElement && n !== list; n = n.offsetParent) {
      y += n.offsetTop - n.scrollTop;
    }
    return y;
  }

  /**
   * Trim the plate back inside its row's scroller.
   *
   * The plate has to sit OUTSIDE that scroller to be able to travel to a row beyond
   * it, which means the scroller's own overflow no longer clips it: point at a row
   * that a scroll has left half out of view and the wash spills past the edge, over
   * the field above or the rule below. This puts that clipping back by hand.
   *
   * Rectangular, and only on the edge that is actually cut — the plate keeps its
   * corner everywhere it isn't. Rows whose box doesn't scroll (every other menu, and
   * this one's footer) take no clip at all, which is also what lets the wash slide
   * out from under the scroller's edge on its way to "New list": the destination
   * isn't in a scroller, so nothing trims the move.
   */
  function clipTo(plate: HTMLElement, row: HTMLElement, list: HTMLElement) {
    const box = row.offsetParent;
    if (!(box instanceof HTMLElement) || box === list || box.scrollHeight <= box.clientHeight) {
      plate.style.clipPath = "";
      return;
    }
    const top = offsetIn(box, list);
    const y = offsetIn(row, list);
    const over = Math.max(0, top - y);
    const under = Math.max(0, y + row.offsetHeight - (top + box.clientHeight));
    const r = "var(--popover-item-radius)";
    plate.style.clipPath = over || under
      ? `inset(${over}px 0 ${under}px 0 round ${over ? "0" : r} ${over ? "0" : r} ${under ? "0" : r} ${under ? "0" : r})`
      : "";
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
    at = row;

    const first = !plate.classList.contains("is-on");
    if (first) plate.classList.add("is-placing");
    plate.style.transform = `translateY(${offsetIn(row, list)}px)`;
    plate.style.height = `${row.offsetHeight}px`;
    clipTo(plate, row, list);
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

  // Scrolling under a still pointer moves the row out from under the wash, and no
  // pointer event says so. Re-place it, silently: this is the row following the
  // scroll rather than the plate travelling anywhere, and a 200ms ease on it would
  // just make the wash lag the list it's meant to be lighting.
  function follow() {
    const plate = plateRef.value;
    const list = listRef.value;
    if (!plate || !list || !at || !plate.classList.contains("is-on")) return;
    plate.classList.add("is-placing");
    plate.style.transform = `translateY(${offsetIn(at, list)}px)`;
    clipTo(plate, at, list);
    void plate.offsetHeight;
    plate.classList.remove("is-placing");
  }
  // capture, because scroll doesn't bubble — the scroller is INSIDE the list, and
  // this is the one listener the `on` object below can't carry
  watch(listRef, (el, old) => {
    old?.removeEventListener("scroll", follow, true);
    el?.addEventListener("scroll", follow, true);
  });

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
