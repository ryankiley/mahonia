<script setup lang="ts">
import type { ListSnapshot } from "~~/shared/types";
import { categoryColor } from "~~/shared/categories";
import { categorySegments, displacedIds } from "~~/shared/categorySegments";
import { formatWeight } from "~~/shared/weights";

const props = defineProps<{ list: ListSnapshot }>();

// one folder-grouped rollup (sorted by weight; ungrouped items fold into
// "Other"); empty / weightless lists give []
//
// `share` is the segment's fraction of the bar, and it is the flex-grow. The weight
// itself used to be, which draws the same bar at rest but can't be animated: grow
// factors that add up to 1 fill the track and ones that add up to less leave the rest
// of it empty, so a segment arriving from 0 while the others give up exactly its share
// keeps the bar full on every frame, and a list's first segment (alone, 0 to 1) wipes
// across the rail instead of taking all of it on the first frame, as any weight in
// milligrams would.
//
// `key` is the folder, so the segment that grew is the one that widens, plus how many
// times that folder has CHANGED PLACES. The bar is in weight order, so an edit can lift
// a folder past its neighbours, and a keyed node that Vue moves is re-inserted: to the
// browser a new element, which restarts from the starting style below while its old
// slot closes at once, and the bar stops short of its right edge until it has grown
// back. A new key makes the move two things the bar already does. The segment in the
// old place leaves, the one in the new place arrives, the two shares pass between them
// and the bar is full throughout.
type Bar = ReturnType<typeof categorySegments>[number] & { key: string; share: number };
const segments = shallowRef<Bar[]>([]);
const turns = new Map<string, number>();

// A segment grows in from nothing (the @starting-style rule below) only when an EDIT
// brought it: `arriving` is up for the two frames after the weights change, which is
// when the browser styles the new node for the first time. Any other first styling
// shows the bar as it is. There are two, and both would otherwise wipe the whole bar
// in: the page loading (so nothing arms until the bar has been on screen for a beat),
// and the bar coming back from display: none, which is what leaving Trip is and what
// a starting style was invented for.
// Two frames and not one: a frame callback runs before that frame's styling, so the
// first one is still ahead of the render it would be disarming.
const arriving = ref(false);
let settled = false;
let armed = 0;
function afterTwoFrames(fn: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}
onMounted(() => afterTwoFrames(() => (settled = true)));

// pre-flush (the default), so one edit that touches two folders is one new order
watch(
  () => categorySegments(props.list),
  (next, prev) => {
    const ids = next.map((s) => s.id);
    for (const id of displacedIds(prev?.map((s) => s.id) ?? [], ids)) turns.set(id, (turns.get(id) ?? 0) + 1);
    const total = next.reduce((sum, s) => sum + s.mg, 0);
    segments.value = next.map((s) => ({ ...s, key: `${s.id}:${turns.get(s.id) ?? 0}`, share: s.mg / total }));
    if (settled) {
      // the latest edit's two frames, not the first's: a second edit a frame behind
      // the first would be disarmed by it before its own node was styled
      const mine = ++armed;
      arriving.value = true;
      afterTwoFrames(() => {
        if (mine === armed) arriving.value = false;
      });
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="catbar" :class="{ 'is-arriving': arriving }">
    <!-- flex track: a small gap separates adjacent colours so they always read as distinct.
         empty lists keep a blank rail (the track's own ground) so the bar never reflows in
         when the first weighted item lands.
         <TransitionGroup> is here for the leave alone: a folder's last weight going has to
         shrink its segment to nothing before the node is removed, or the others would grow
         into a hole. -->
    <TransitionGroup
      tag="div"
      name="seg"
      class="catbar__track"
      :class="{ 'is-empty': !segments.length }"
      role="img"
      aria-label="Weight by folder"
    >
      <span
        v-for="s in segments"
        :key="s.key"
        class="catbar__seg"
        :style="{ '--share': s.share, background: categoryColor(s.colorKey) }"
        :title="`${s.name} · ${formatWeight(s.mg, list.displayUnit)}`"
      />
    </TransitionGroup>
    <ul v-if="segments.length" class="legend catbar__legend">
      <li v-for="s in segments" :key="s.id" class="legend__item catbar__item">
        <span class="swatch" :style="{ background: categoryColor(s.colorKey) }" />
        <span class="catbar__name">{{ s.name }}</span>
        <span class="catbar__wt">
          <span class="t-num t-sm catbar__num">{{ formatWeight(s.mg, list.displayUnit, { withUnit: false }) }}</span>
          <span class="t-sm catbar__unit">{{ list.displayUnit }}</span>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped lang="scss">
/* The bar redraws by MOVING: an edit that changes a folder's weight slides the
   boundaries to where they now belong, on the step spring (a small move in the flow).
   Every part of a segment's width is in the one transition, so they all leave and land
   together: its share, its floor, and the hairline gap before it. The gap is a margin
   rather than the track's `gap` for that reason: a gap belongs to the pair, appears whole
   the moment a segment does, and would tick the rest of the bar a pixel sideways at each
   end of an arrival. */
.catbar__track {
  display: flex;
  height: var(--bar-h);
  transition: background-color var(--spring-fade-dur) var(--spring-fade);
}
.catbar__track.is-empty {
  background-color: var(--border-primary);
}
.catbar__seg {
  flex-grow: var(--share);
  flex-basis: 0;
  min-width: var(--bar-seg-min);
  transition:
    flex-grow var(--spring-step-dur) var(--spring-step),
    min-width var(--spring-step-dur) var(--spring-step),
    margin-inline-start var(--spring-step-dur) var(--spring-step);
}
/* The gap goes before every segment that has a STAYING one ahead of it, which is
   :not(:first-child) until the first segment is the one leaving. Then the next one is
   the bar's left end from that moment, and gives its gap up as the leaver shrinks; on
   :first-child it would have kept it until the node was removed and the bar's left
   edge sat a gap inside the column for the whole exit, then slid back. */
.catbar__seg:not(.seg-leave-active) ~ .catbar__seg {
  margin-inline-start: var(--space-px);
}
/* Arriving is CSS's (@starting-style) and not <TransitionGroup>'s enter classes, which
   land a frame or two after the insert. The other segments start giving up the
   newcomer's share on the insert itself, so for the length of that lag the shares add
   up to less than 1 and the bar stops short of its right edge. A starting style begins
   in the same frame as theirs. An engine without it shows the segment at its share at
   once, with the others still easing over: more than 1 in total, which flex divides
   by ratio, so nothing gapes. */
@starting-style {
  .catbar.is-arriving .catbar__track > .catbar__seg {
    flex-grow: 0;
    min-width: 0;
    margin-inline-start: 0;
  }
}
/* Leaving is late by the same frame or two, which is harmless in this direction: too
   much share, not too little. */
.catbar__track > .catbar__seg.seg-leave-to {
  flex-grow: 0;
  min-width: 0;
  margin-inline-start: 0;
}
/* AN EXCEPTION TO THE KEYBOARD RULE. What a key sets off lands in one frame
   (atoms/modality.scss): motion on the thing under the hands reads as the interface
   lagging behind them. The bar is not that thing. A weight is typed in a row further
   down the page, and the bar is the readout of it; snapping there made the one edit
   people make most, typing a weight, the one edit the bar never showed moving. A
   transition retargets from wherever it is, so a held arrow key in a weight field
   gives a bar that follows, not one that restarts.
   Whole selector in :global, since :global(a) b drops b's scope instead of keeping it.
   Inside no-preference: this has to out-rank the keyboard rule, and would out-rank the
   reduced-motion one in main.scss with it. */
@media (prefers-reduced-motion: no-preference) {
  :global(:root[data-input="keyboard"] .catbar__seg) {
    transition-duration: var(--spring-step-dur) !important;
  }
  :global(:root[data-input="keyboard"] .catbar__track) {
    transition-duration: var(--spring-fade-dur) !important;
  }
}
/* the row, the hanging indent and the dot's gap are the .legend atom's (controls.scss).
   TEXT FLOW, not a flex row. A folder name is as long as its owner made it, and once
   one wrapped, a flex row put the dot in the middle of the block (align-self: center
   centres against the whole item, not the line it belongs to) and left the weight up
   on the first line with the rest of the name running underneath it — a number with
   text flowing under it reads as a different column, not as this entry's figure.
   Inline, the three parts read as one line of text that happens to wrap: dot first,
   weight trailing the name it belongs to. The hanging indent (padding + negative
   text-indent, both off --swatch) keeps the wrapped lines under the NAME rather than
   under the dot, so the dot reads as the bullet it is. */
.catbar__item {
  /* A flex item's automatic minimum is its MIN-CONTENT width, so a folder name with no
     space or hyphen in it sized this entry to the whole word and ran it off the side of
     the page — the legend clips, so the name was cut with no ellipsis and no way to
     scroll to the rest. The reset's `min-width: 0` on every element (reset.scss) lets
     the entry shrink, which is what lets the inherited overflow-wrap actually break the
     word; `max-width` keeps it inside the legend once it has. */
  max-width: 100%;
}
/* folder names read as labels — same treatment as the Base/Worn chips (t-label):
   strong weight, secondary foreground. The figure beside them keeps primary foreground. */
.catbar__name {
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-secondary);
}
/* the figure carries the data (primary foreground); its unit is secondary
   (--foreground-secondary, the one de-emphasis level — same as every other unit), and the
   two sit tight as one "1,300 g" pair — which trails the name's last word rather than
   breaking from it. text-indent is reset because the hanging indent above belongs to the
   ITEM, and a browser that applied it to this inline box would pull the figure over the
   name. */
.catbar__wt {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-px);
  margin-inline-start: var(--space-2);
  text-indent: 0;
}
.catbar__num {
  color: var(--foreground-primary);
}
.catbar__unit {
  color: var(--foreground-secondary);
}
/* roomier separation between folder entries when they sit on one line on a phone */
@media (max-width: $bp-stack) {
  .catbar__legend {
    column-gap: var(--space-6);
  }
}
</style>
