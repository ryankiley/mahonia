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
        class="modebar__opt pplbar__chip"
        :class="{ 'is-active': selected === c.key }"
        role="radio"
        :aria-checked="selected === c.key"
        :tabindex="selected === c.key ? 0 : -1"
        :title="c.title"
        @click="pick(c.key)"
      >
        <span
          v-if="c.color || c.hollow"
          class="swatch"
          :class="{ 'swatch--hollow': c.hollow }"
          :style="c.color ? { background: c.color } : undefined"
          aria-hidden="true"
        />
        <!-- the name in its own box so it can clip: a person's name runs to 60
             characters, and the chip used to run out past the screen's edge with it.
             The chip's title carries the whole name for a pointer. -->
        <span class="pplbar__name t-clip">{{ c.label }}</span><!--
        the chip's carry, riding a step off the name in the chip's OWN foreground — the
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
}
/* THE MODE BAR'S CHIP (.modebar__opt, atoms/modebar.scss), with an edge. These chips
   are read WITH that bar — the same kind of thing, a small labelled chip you press to
   change what the page shows, a few rows apart — so they wear its class rather than a
   copy of it: the option height and its row rhythm, --radius-2 (not the pill: that is
   for a button standing on its own, and a row of options never does), the chrome type
   and the quiet foreground, the wash under a pointer, the inward focus ring, the
   --background-selected plate when chosen (the app's one on-plate, and it answers the
   pointer a step up), and on a coarse pointer the transparent ::before that makes a 32px
   chip a 44px target — top and bottom only, since the chips sit --space-1 apart and an
   overhang sideways would hand a neighbour's edge to the wrong chip. Where chips wrap
   onto a second row the two rows' overhangs overlap across the 4px between them and 2px
   into each face; the lower chip, later in the tree, takes that strip. A small cost
   against a target that was 14px short.
   What a chip here adds: a HAIRLINE, so an OFF chip still has an edge to find, unlike
   the bar's flat words which live inside one plate; and room for a dot and a carry
   beside the name. */
.pplbar__chip {
  gap: var(--space-2);
  padding: 0 var(--space-3);
  /* The outline IS the unselected chip — there is no fill under it — so in dark it takes
     the stronger hairline. --border-primary there is 8% white, #141414 on a black page:
     enough for a rule between two rows of text, not for a shape drawn in nothing else (Ryan,
     2026-11-25: "outline states are a little dim"). Light keeps --border-primary. */
  border: 1px solid light-dark(var(--border-primary), var(--border-strong));
  /* Never wider than the row. Uncapped, a name near the 60-character limit drew a
     chip wider than a 320px screen and ran off it; capped, the chip stops at the
     row's edge and the name inside it clips (.pplbar__name). */
  max-width: 100%;
}
/* The name is the one part of the chip that gives way: it wears .t-clip in the markup.
   The dot and the carry are flex: none (the dot by .swatch, the carry below) so a long
   name can never squeeze them out. */
/* ON: the hairline steps aside so the plate reads as the edge, not a border around a
   border. */
.pplbar__chip.is-active {
  border-color: transparent;
}
/* (the hollow "no colour yet" dot is the shared .swatch--hollow atom — controls.scss) */
/* The carry takes the chip's OWN foreground: t-muted is --foreground-secondary, a step
   DARKER than a resting chip's --foreground-tertiary, so the qualifier out-shouted the
   name it qualifies on every chip but the lit one. No margin — the chip's flex gap is the
   spacing, and a margin on top of it doubled the step. */
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
