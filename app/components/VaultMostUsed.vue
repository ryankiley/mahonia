<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { gearIcon } from "~/utils/gearIcons";
import type { Unit } from "~~/shared/types";
import type { VaultEntry } from "~~/shared/vault";
import { formatWeight } from "~~/shared/weights";

// The top of My Gear: the handful of pieces you pack most, as tiles with a big icon,
// so the page opens on the gear you actually carry rather than on a search box and a
// hundred rows. Ranked by timesSeen, the count of lists that reached for a piece (the
// same signal the Most used view sorts by). No "See all": the order picker under the
// shelf is that view, one control away, and a link that only flipped it read as
// doing nothing whenever it was already the order.
//
// Gone until there is a history to rank: a closet whose every piece has been seen once
// (a fresh import, a new account) has no "most", and a shelf of six arbitrary rows
// would claim one.
const props = defineProps<{ items: VaultEntry[]; unit: Unit }>();
const emit = defineEmits<{ open: [entry: VaultEntry] }>();

/** One row of tiles on a laptop: a shelf, not a second list. */
const SHELF = 6;
/** Fewer pieces than this with any history, and there's nothing to call "most". */
const MIN_RANKED = 3;

const top = computed(() => {
  const used = props.items.filter((i) => i.timesSeen > 1);
  if (used.length < MIN_RANKED) return [];
  return used
    .sort((a, b) => b.timesSeen - a.timesSeen || b.lastUsedAt.localeCompare(a.lastUsedAt))
    .slice(0, SHELF)
    .map((entry) => ({ entry, icon: gearIcon(entry.commonName, entry.name, entry.icon) }));
});
</script>

<template>
  <section v-if="top.length" class="mu" aria-labelledby="mu-head">
    <h2 id="mu-head" class="t-sm t-muted mu__title">Most used</h2>
    <ul class="mu__list">
      <li v-for="{ entry, icon } in top" :key="entry.id" class="mu__item">
        <button
          type="button"
          class="mu__tile"
          :aria-label="`${entry.brand ? `${entry.brand} ` : ''}${entry.name}, ${formatWeight(entry.weightMg, entry.entryUnit ?? unit)}`"
          @click="emit('open', entry)"
        >
          <!-- absolute stroke: 1.75px lines at 32px, close to the rows' 1.67 at 20px,
               where scaling the rows' 2 up would draw them nearly 3px thick -->
          <span class="mu__icon" aria-hidden="true">
            <HugeiconsIcon v-if="icon" :icon="icon" :size="32" :stroke-width="1.75" absolute-stroke-width />
          </span>
          <span class="mu__name">{{ entry.name }}</span>
          <!-- what it is, and only that: a tile shows the model name alone, and a model
               name can mislead ("Hiker Boot Midweight" is a sock), so the type says what
               the icon above is a picture of. No weight: the shelf is for finding a
               piece, and the row below has its weight. The brand stands in for a piece
               with no type. -->
          <span v-if="entry.commonName || entry.brand" class="mu__meta t-sm t-muted t-clip">{{ entry.commonName || entry.brand }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
.mu {
  margin-bottom: var(--space-5);
}
.mu__title {
  margin: 0 0 var(--space-2);
  font-weight: inherit;
}
/* Flat tiles separated by their gutters, not outlines: surfaces here are told apart
   by tone, and an outline is what an OPEN thing wears. */
.mu__list {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}
.mu__item {
  display: flex;
  min-width: 0;
}
.mu__tile {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  padding: var(--space-3);
  border: 0;
  border-radius: var(--radius-3);
  background: var(--paper-2);
  color: var(--ink);
  font: inherit;
  text-align: start;
  cursor: pointer;
  transition: background var(--spring-fade-dur) var(--spring-fade);
}
@media (hover: hover) and (pointer: fine) {
  .mu__tile:hover {
    background: var(--paper-3);
  }
}
.mu__tile:active {
  opacity: 0.7;
}
.mu__icon {
  display: inline-flex;
  width: 32px;
  height: 32px;
  margin-bottom: var(--space-3);
}
/* two lines, then clipped: "Hiker Boot Midweight" fits, a catalog's whole product
   title doesn't need to */
.mu__name {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  max-width: 100%;
  line-height: 1.25;
}
.mu__meta {
  max-width: 100%;
  margin-top: auto;
}
/* Three across on a tablet; on a phone the shelf scrolls sideways, out to the screen
   edges so a tile slides under the edge instead of being cut at the gutter. */
@media (max-width: 52rem) {
  .mu__list {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: $bp-stack) {
  .mu__list {
    --mu-gutter: max(var(--space-4), env(safe-area-inset-left, 0px));
    margin-inline: calc(-1 * var(--mu-gutter));
    padding-inline: var(--mu-gutter);
    scroll-padding-inline: var(--mu-gutter);
    grid-template-columns: none;
    grid-auto-flow: column;
    grid-auto-columns: 38%;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
  }
  .mu__list::-webkit-scrollbar {
    display: none;
  }
  .mu__item {
    scroll-snap-align: start;
  }
}
</style>
