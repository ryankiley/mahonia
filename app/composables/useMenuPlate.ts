import type { Ref } from "vue";

/**
 * The travelling hover plate for `.menu__list` — ONE wash that moves between rows
 * instead of a background painted on each.
 *
 * Ported from the design system's ds-menu. The CSS half lives in
 * atoms/controls.scss (`.menu__plate`); this is the half that has to measure, and
 * two things about it are non-obvious enough to be worth stating:
 *
 *  • It reads `offsetTop`, NOT a rect delta. The menu's enter transition SCALES
 *    the card (see the motion block in controls.scss), so a getBoundingClientRect
 *    delta comes back in scaled pixels — and a translate applied inside that same
 *    scaled card scales a second time. The wash lands short of the row it's
 *    lighting, worse the further down the card you go. Layout space is immune.
 *
 *  • The FIRST placement is made silently. With nothing to travel from, the plate
 *    would fly in from the top of the card; `placing` kills the transition, a
 *    forced reflow flushes that, then it comes back off. It's a class rather than
 *    an inline style so the transition itself stays in the stylesheet.
 *
 * It follows FOCUS as well as the pointer, deliberately: a menu whose only
 * "you are here" mark is reserved for people with a mouse works worse the more you
 * rely on the keyboard.
 *
 * Usage — three things in the consuming component:
 *   const { plateRef, listRef, placing, on } = useMenuPlate();
 *   <ul ref="listRef" v-on="on"> <span ref="plateRef" class="menu__plate" …/> …
 * Rows are identified by `[data-row]`, so an item that shouldn't light (a section
 * header, a separator) simply doesn't carry it.
 */
export function useMenuPlate(): {
  plateRef: Ref<HTMLElement | null>;
  listRef: Ref<HTMLElement | null>;
  placing: Ref<boolean>;
  on: {
    pointerover: (e: PointerEvent) => void;
    pointerleave: () => void;
    focusin: (e: FocusEvent) => void;
    focusout: (e: FocusEvent) => void;
  };
} {
  const plateRef = ref<HTMLElement | null>(null);
  const listRef = ref<HTMLElement | null>(null);
  const placing = ref(false);

  function hide() {
    plateRef.value?.classList.remove("is-on");
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
    if (first) placing.value = true;
    // measured against the plate's own offsetParent, which is the list; a row
    // nested in an <li> still reports its position in that same space
    plate.style.transform = `translateY(${row.offsetTop}px)`;
    plate.style.height = `${row.offsetHeight}px`;
    if (first) {
      void plate.offsetHeight; // flush, so the placement can't be animated
      placing.value = false;
    }
    plate.classList.add("is-on");
  }

  const rowFrom = (t: EventTarget | null) =>
    t instanceof Element ? t.closest<HTMLElement>("[data-row]") : null;

  return {
    plateRef,
    listRef,
    placing,
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
