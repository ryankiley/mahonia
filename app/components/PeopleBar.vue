<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
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
   * Hide the trailing manage button (the read views have no one to manage).
   * NOT named `readonly`: that word is a Vue auto-import, and a setup-scope
   * binding by the same name would silently shadow the prop.
   */
  noManage?: boolean;
  /**
   * Each chip's carry, pre-formatted, keyed by person id (+ the UNASSIGNED
   * sentinel) — the "divisible by participants" figure at a glance. Absent (or
   * missing a key) = no suffix, which is a list without weights.
   */
  weights?: Record<string, string>;
}>();

const emit = defineEmits<{ pick: [selection: PersonSelection]; manage: [] }>();

// ONE array driving one v-for — not three sibling groups sharing a ref name: a
// template ref only collects into an array within a single v-for, so the mixed
// shape left the arrows a ref that held whichever plain chip rendered last.
const chips = computed<{ key: PersonSelection; label: string; color?: string; hollow?: boolean; weight?: string }[]>(() => [
  // Everyone carries no figure — the totals bar right above it is that figure
  { key: null, label: "Everyone" },
  ...props.people.map((p) => ({
    key: p.id as PersonSelection,
    label: p.name,
    color: personColor(p),
    weight: props.weights?.[p.id],
  })),
  ...(props.showUnassigned
    ? [{ key: UNASSIGNED as PersonSelection, label: "Unassigned", hollow: true, weight: props.weights?.[UNASSIGNED] }]
    : []),
]);

const pick = (key: PersonSelection) => emit("pick", key === props.selected ? null : key);

const opts = useTemplateRef<HTMLButtonElement[]>("opts");

// ModeBar's roving arrows, verbatim in shape: selection follows focus, wraps at
// the ends. Arrows SET rather than toggle — a radio you arrow onto is chosen.
function onKey(e: KeyboardEvent) {
  if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
  const i = chips.value.findIndex((c) => c.key === props.selected);
  if (i < 0) return;
  e.preventDefault();
  const step = /Left|Up/.test(e.key) ? -1 : 1;
  const at = (i + step + chips.value.length) % chips.value.length;
  emit("pick", chips.value[at]!.key);
  nextTick(() => opts.value?.[at]?.focus());
}
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
        @click="pick(c.key)"
      >
        <span
          v-if="c.color || c.hollow"
          class="swatch pplbar__dot"
          :class="{ 'swatch--hollow': c.hollow }"
          :style="c.color ? { background: c.color } : undefined"
          aria-hidden="true"
        />
        {{ c.label }}<!--
        the chip's carry, riding a step off the name in the chip's OWN ink — the
        pill shape is what keeps it reading as a control, not a readout chip
        --><span v-if="c.weight" class="t-num pplbar__wt">{{ c.weight }}</span>
      </button>
    </div>
    <Tooltip v-if="!noManage" text="People on this trip" preferred-placement="top">
      <button
        type="button"
        class="btn btn--icon btn--ghost pplbar__manage"
        aria-label="People on this trip"
        aria-haspopup="dialog"
        @click="emit('manage')"
      >
        <HugeiconsIcon :icon="UserGroupIcon" :size="16" :stroke-width="2" aria-hidden="true" />
      </button>
    </Tooltip>
  </div>
</template>

<style scoped lang="scss">
.pplbar {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}
.pplbar__chips {
  display: flex;
  flex-wrap: wrap; /* six named people on a phone still all reachable */
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}
/* The armchip's shape (TrailPlanPanel's day chips) in the page's own tokens —
   that one hardcodes literals because it floats over a map; this row sits on
   paper and speaks paper's language. Pill + hairline so an OFF chip still has
   an edge to find, unlike the modebar's flat words which live inside one plate. */
.pplbar__chip {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 30px; /* the modebar's option height — same row rhythm */
  padding: 0 var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: none;
  cursor: pointer;
  font-family: inherit;
  font-size: var(--text-chrome);
  color: var(--ink-3);
  white-space: nowrap;
  transition:
    background-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
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
  outline: 2px solid var(--ink);
  outline-offset: -2px;
}
/* ON is the app's one on-plate (--lit), same as the mode switcher and the
   classification marks — and the hairline steps aside so the plate reads as the
   edge, not a border around a border. */
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
/* the manage button holds the row's trailing edge and doesn't shrink under wrap */
.pplbar__manage {
  flex: none;
  margin-left: auto;
}
</style>
