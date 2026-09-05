<script setup lang="ts">
import { HugeiconsIcon, type IconNode } from "~/utils/hugeicon";
import { CheckIcon } from "@hugeicons/core-free-icons";

// Pick one of a few things — the app's answer to a native <select>.
//
// There were five of those, all built the same way: a transparent native select laid
// over some custom markup. The behaviour came free, but the list it opened was the
// operating system's, which made it the one surface in the app that didn't look like
// the app. Two sort pickers (the editor's folder headers and the vault's) and three
// unit pickers (the editor total, the vault total, and each item row).
//
// What differs between them is only the TRIGGER — a glyph, a display-size figure, a
// caption-sized unit. So the trigger is a slot and everything else lives here: the
// popover, the travelling plate, the check on the current row, outside-tap and Escape.
// The button itself stays in this component so aria-haspopup/expanded can't drift.
type Option = { key: string; label: string; icon?: IconNode };

const props = defineProps<{
  options: readonly Option[];
  /** the active key — its row carries the check, and it's handed to the trigger slot */
  current: string;
  /** the control's accessible name, e.g. "Sort items in Shelter", "Weight unit" */
  label: string;
  /**
   * A different accessible name for the TRIGGER, when the trigger draws something a
   * reader needs to hear.
   *
   * `aria-label` on a button replaces its contents, which is right when the trigger is
   * one abbreviation ("g") and "Weight unit for this item" says more. It is wrong when
   * the trigger holds a VALUE: the planning view's distance headline announced as
   * "Distance unit" and the number itself — the largest thing on the page — was never
   * spoken at all. Callers whose trigger carries a figure pass it here; the menu keeps
   * the plain `label`, because "39.7 mi, change unit" is a poor name for a list of units.
   */
  triggerLabel?: string;
  /** styling hook for the trigger button; the caller owns how its trigger looks */
  triggerClass?: string;
  title?: string;
  /**
   * How the trigger's own contents line up. "center" suits an icon or a plain word;
   * "baseline" is for a trigger built from TYPE — the editor's total, where the unit
   * and chevron have to sit on the big figure's baseline.
   *
   * A PROP and not a class the caller passes through `triggerClass`, because a class
   * can't carry the caller's scoped styles across a component boundary: the button
   * only ever gets THIS component's data-v attribute, so `.totals__unitbtn { … }` in
   * TotalsBar's scoped block silently matched nothing and the unit fell off its
   * baseline. Anything that must actually restyle this button belongs here.
   */
  align?: "center" | "baseline";
}>();
const emit = defineEmits<{ pick: [key: string]; overlayToggle: [boolean] }>();

const open = ref(false);
const rootRef = useTemplateRef<HTMLElement>("rootRef");
// the travelling wash shared with every other menu (useMenuPlate)
const { plateRef, listRef, on: plateOn } = useMenuPlate();
// which sides to hang from, measured rather than declared — see useMenuPlacement.
// On open, because a menu can't change size while it's up.
const { atStart, above, place } = useMenuPlacement(listRef);
watch(open, (o) => o && nextTick(place));

// The list is position:absolute, so a clipping ancestor crops it — the unit menu on
// a folder's LAST row opened downward into the collapse clip (overflow:hidden on the
// folder body) and lost every option past the folder's bottom edge. Ancestors that
// own such a clip listen for this and lift it while the menu is up, the same
// overlayToggle contract the name autocomplete keeps (ItemInput → FolderSection).
// Deduped so the folder's +1/−1 count can't unbalance, and released only at the
// leave transition's END: releasing at leave start let the returning clip guillotine
// the exiting menu at t=0 — everything past the fold vanished instantly while the
// slice inside kept fading (ItemInput documents the same artifact). A leave
// cancelled by reopening never fires after-leave, and the dedup makes the re-show a
// no-op — the clip just stays lifted through the blink.
let lifted = false;
function setLift(v: boolean) {
  if (lifted === v) return;
  lifted = v;
  emit("overlayToggle", v);
}
watch(open, (o) => o && setLift(true));
onBeforeUnmount(() => setLift(false));

useMenuDismiss(open, rootRef);

const active = computed(() => props.options.find((o) => o.key === props.current) ?? props.options[0]);
function pick(key: string) {
  open.value = false;
  emit("pick", key);
}
</script>

<template>
  <div ref="rootRef" class="menu optmenu">
    <button
      type="button"
      class="optmenu__btn"
      :class="[triggerClass, { 'optmenu__btn--baseline': align === 'baseline' }]"
      :title="title"
      :aria-label="triggerLabel ?? label"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
    >
      <!-- the caller draws its own trigger; `active` is the option it should show and
           `open` lets it turn a chevron over -->
      <slot name="trigger" :active="active" :open="open" />
    </button>
    <Transition name="menu" @after-leave="setLift(false)">
      <ul
        v-if="open"
        ref="listRef"
        class="popover menu__list optmenu__list"
        :class="{ 'menu__list--start': atStart, 'menu__list--above': above }"
        role="menu"
        :aria-label="label"
        v-on="plateOn"
      >
        <li role="none" aria-hidden="true">
          <span ref="plateRef" class="menu__plate" />
        </li>
        <li v-for="o in options" :key="o.key" role="none">
          <button
            type="button"
            data-row
            role="menuitem"
            class="menu__item"
            :aria-current="o.key === current ? 'true' : undefined"
            @click="pick(o.key)"
          >
            <!-- :icon, NOT <component :is>. A hugeicons icon is PATH DATA rather than
                 a component, so :is would try to render an array and fail. -->
            <HugeiconsIcon v-if="o.icon" :icon="o.icon" :size="14" :stroke-width="2" aria-hidden="true" />
            <span class="optmenu__label">{{ o.label }}</span>
            <!-- rendered on EVERY row and hidden rather than dropped — see the style -->
            <HugeiconsIcon
              :icon="CheckIcon"
              class="menu__check"
              :class="{ 'is-on': o.key === current }"
              :size="14"
              :stroke-width="2"
              aria-hidden="true"
            />
          </button>
        </li>
      </ul>
    </Transition>
  </div>
</template>

<style scoped>
.optmenu {
  display: inline-flex;
  align-items: center;
}
/* The trigger is bare by default — no .btn chrome — because most of these wrap
   something that is already the affordance (a display figure, a caption, a glyph).
   Callers add .btn--icon and friends through `triggerClass` when they want the box.
   Colour inherits so a caller can light its glyph for a non-default value, which is
   how a sorted folder reads as sorted even collapsed. */
.optmenu__btn {
  display: inline-flex;
  /* CENTRE by default. Baseline is right for a trigger built from type — the total,
     where the unit has to sit on the big figure's baseline — but it is wrong for an
     icon-only one, where it lifted the glyph 8px above the trash and grip beside it.
     The type-based triggers ask for baseline through `triggerClass`. */
  align-items: center;
  gap: var(--space-2);
  padding: 0; /* over .btn's, for the callers that pass it through triggerClass */
  color: inherit;
  text-align: start;
  cursor: pointer;
}
.optmenu__btn--baseline {
  align-items: baseline;
}
.optmenu__list {
  min-width: 7rem;
}
/* icon · label · check is .menu__item's own row now (atoms/controls.scss), and the
   check is the shared .menu__check. The label still takes the slack, which is what
   holds the mark on the trailing edge and — with the atom's `flex: none` on the
   glyphs — keeps the leading icon from being the one thing in the row left to shrink.
   Without that pinning it collapsed to zero width on the current row, the one row
   carrying all three, pulling that label 14px out of line with every other. */
.optmenu__label {
  flex: 1 1 auto;
  text-align: start;
}
</style>
