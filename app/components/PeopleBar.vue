<script setup lang="ts">
import { personColor, UNASSIGNED, type PersonSelection } from "~~/shared/people";
import type { Person } from "~~/shared/types";

// Who the list is narrowed to — a chips row above the folders, one chip per
// person plus "Everyone" and (while anything is unclaimed) "Unassigned".
//
// A RADIOGROUP like ModeBar, and for ModeBar's reason: the chips are one value
// with N settings, not N destinations — and the roving tabindex keeps the row
// one Tab stop. Dumb on purpose (props + emits, no controller): the editor and
// the read-only views both render it, and only the editor has a useGearList.
//
// The toggle lives HERE, not in each parent: clicking the active chip emits the
// everyone value, so both surfaces get click-again-to-clear by just assigning.

const props = defineProps<{
  people: readonly Person[];
  selected: PersonSelection;
  /** offer the "Unassigned" chip (some top-level row has no one yet) */
  showUnassigned?: boolean;
  /**
   * Each chip's carry, pre-formatted, keyed by person id (+ the UNASSIGNED
   * sentinel) — the "divisible by participants" figure at a glance. Absent (or
   * missing a key) = no suffix, which is a list without weights.
   */
  weights?: Record<string, string>;
}>();

const emit = defineEmits<{ pick: [selection: PersonSelection] }>();

// ONE array driving one v-for — not three sibling groups sharing a ref name: a
// template ref only collects into an array within a single v-for, so the mixed
// shape left the arrows a ref that held whichever plain chip rendered last.
// `title` is a person chip's whole name, for when the chip clips it (.pplbar__name);
// Everyone and Unassigned are the app's own short words and never clip, so they
// carry none rather than a tooltip that repeats the chip.
const chips = computed<{ key: PersonSelection; label: string; title?: string; color?: string; hollow?: boolean; weight?: string }[]>(() => [
  // Everyone carries no figure — the totals bar right above it is that figure
  { key: null, label: "Everyone" },
  ...props.people.map((p) => ({
    key: p.id as PersonSelection,
    label: p.name,
    title: p.name,
    color: personColor(p),
    weight: props.weights?.[p.id],
  })),
  ...(props.showUnassigned
    ? [{ key: UNASSIGNED as PersonSelection, label: "Unassigned", hollow: true, weight: props.weights?.[UNASSIGNED] }]
    : []),
]);

const pick = (key: PersonSelection) => emit("pick", key === props.selected ? null : key);

// ModeBar's roving arrows, from the one place they live (useRovingRadio): selection
// follows focus, wraps at the ends. Arrows SET rather than toggle — a radio you arrow
// onto is chosen.
const { onKey } = useRovingRadio(
  () => chips.value.length,
  () => chips.value.findIndex((c) => c.key === props.selected),
  (at) => emit("pick", chips.value[at]!.key),
);
</script>

<template>
  <div class="pplbar">
    <div class="pplbar__chips" role="radiogroup" aria-label="Filter by person" @keydown="onKey">
      <button
        v-for="c in chips"
        :key="c.key ?? 'everyone'"
        type="button"
        ref="opts"
        class="pplbar__chip"
        :class="{ 'is-on': selected === c.key }"
        role="radio"
        :aria-checked="selected === c.key"
        :tabindex="selected === c.key ? 0 : -1"
        :title="c.title"
        @click="pick(c.key)"
      >
        <span
          v-if="c.color || c.hollow"
          class="swatch pplbar__dot"
          :class="{ 'swatch--hollow': c.hollow }"
          :style="c.color ? { background: c.color } : undefined"
          aria-hidden="true"
        />
        <!-- the name in its own box so it can clip: a person's name runs to 60
             characters, and the chip used to run out past the screen's edge with it.
             The chip's title carries the whole name for a pointer. -->
        <span class="pplbar__name">{{ c.label }}</span><!--
        the chip's carry, riding a step off the name in the chip's OWN ink — the
        bordered chip shape is what keeps it reading as a control, not a readout chip
        --><span v-if="c.weight" class="t-num pplbar__wt">{{ c.weight }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* the row is its chips now — the manage button that shared it moved to the ⋯ menu.
   Kept as an element rather than folded into .pplbar__chips: print.scss stands the
   whole row down by this class, and both parents v-show it. */
.pplbar {
  display: flex;
  /* Match the leading edge of ModeBar's first option. */
  margin-left: calc(var(--space-2) * -1);
}
.pplbar__chips {
  display: flex;
  flex-wrap: wrap; /* six named people on a phone still all reachable */
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}
/* The armchip's shape (TrailPlanPanel's day chips) in the page's own tokens —
   that one takes its fixed-light values from map tokens because it floats over a map;
   this row sits on paper and speaks paper's language. Hairline so an OFF chip still has an edge
   to find, unlike the modebar's flat words which live inside one plate. */
.pplbar__chip {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--control-compact); /* the modebar's option height — same row rhythm */
  padding: 0 var(--space-3);
  border: 1px solid var(--line);
  /* --radius-2, the corner the mode chips and the list picker wear, not the pill.
     These chips are read WITH that bar — the same kind of thing, a small labelled
     chip you press to change what the page shows, a few rows apart — and a pill
     here against rounded rectangles there read as two different controls. The
     pill is for a button standing on its own; a row of options never does. */
  border-radius: var(--radius-2);
  font-size: var(--text-chrome);
  color: var(--ink-3);
  white-space: nowrap;
  /* Never wider than the row. Uncapped, a name near the 60-character limit drew a
     chip wider than a 320px screen and ran off it; capped, the chip stops at the
     row's edge and the name inside it clips (.pplbar__name). */
  max-width: 100%;
  /* the containing block for the touch hit area below */
  position: relative;
  transition:
    background-color var(--spring-fade-dur) var(--spring-fade),
    color var(--spring-fade-dur) var(--spring-fade),
    scale var(--dur-press) var(--ease-out);
}
/* The one part of the chip that gives way. The dot and the carry are flex: none (the
   dot by .swatch, the carry below) so a long name can never squeeze them out. */
.pplbar__name {
  overflow: hidden;
  text-overflow: ellipsis;
}
/* THE TARGET, drawn apart from the chip — the .switch recipe (controls.scss). The chip
   is --control-compact (30px) tall because it is read with the mode bar's options; a
   thumb needs --tap. A transparent ::before overhangs the chip by the shortfall top
   and bottom, so the target is 44px tall and the chip still looks and lays out as it
   did. Not sideways: the chips sit --space-1 apart and are wide enough already, and an
   overhang there would hand a neighbour's edge to the wrong chip. Coarse pointers only,
   unlike the switch: a 30px chip is no small thing to catch with a mouse. Where chips
   wrap onto a second row the two rows' overhangs overlap across the 4px between them
   and 3px into each face; the lower chip, later in the tree, takes that strip. A small
   cost against a target that was 14px short. */
@media (pointer: coarse) {
  .pplbar__chip::before {
    content: "";
    position: absolute;
    inset: calc((var(--control-compact) - var(--tap)) / 2) 0;
  }
}
@media (hover: hover) and (pointer: fine) {
  .pplbar__chip:hover {
    background: light-dark(
      color-mix(in oklab, var(--ink) 3.5%, transparent),
      color-mix(in oklab, var(--ink) 5%, transparent)
    );
    color: var(--ink);
  }
}
.pplbar__chip:focus-visible {
  outline: var(--focus-ring) solid var(--ink);
  outline-offset: var(--focus-offset-inset);
}
/* ON is the app's one on-plate (--lit), same as the mode switcher and the
   classification marks — and the hairline steps aside so the plate reads as the
   edge, not a border around a border. */
@media (hover: hover) and (pointer: fine) {
  .pplbar__chip.is-on:hover {
    background: var(--lit-hover); /* the selected chip answers the pointer too */
  }
}
.pplbar__chip.is-on {
  background: var(--lit);
  border-color: transparent;
  color: var(--ink);
}
/* (the hollow "no colour yet" dot is the shared .swatch--hollow atom — controls.scss) */
/* The carry takes the chip's OWN ink: t-muted is --ink-2, a step DARKER than a
   resting chip's --ink-3, so the qualifier out-shouted the name it qualifies on
   every chip but the lit one. No margin — the chip's flex gap is the spacing,
   and a margin on top of it doubled the step. */
.pplbar__wt {
  flex: none;
  color: inherit;
}
@media (max-width: $bp-stack) {
  /* the chips are a control first — at phone width the suffixes turned a
     one-line row into three or four, and the headline says the selected
     person's carry the moment a chip is picked */
  .pplbar__wt {
    display: none;
  }
}
</style>
