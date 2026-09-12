<script setup lang="ts">
import type { ChangelogEntry } from "~~/server/api/changelog.get";

// The release list of What's new: a date rail on the left, the day's entries on the
// right, grouped Added / Changed / Fixed. Its own component because two pages draw it
// now: /changelog draws every release, and /about draws only the newest as a taste of
// the page. One renderer, so the two can't drift the way the bullets once did.
//
// Dates print through formatCalendarDate (app/utils/time, auto-imported): parsed in
// LOCAL time from the parts, because `new Date("2026-06-27")` is UTC midnight and
// renders as the day before west of UTC, and in a FIXED locale, never `undefined`:
// both pages are prerendered, so a runtime-locale format would differ between the
// build server and the visitor's browser and trip a hydration mismatch.
defineProps<{ releases: ChangelogEntry[] }>();
</script>

<template>
  <section v-for="rel in releases" :key="rel.date" class="log__rel">
    <h3 class="log__date">
      <time :datetime="rel.date" class="t-title">{{ formatCalendarDate(rel.date) }}</time>
      <span v-if="rel.title" class="log__title t-sm t-muted">{{ rel.title }}</span>
    </h3>

    <div class="log__body">
      <div v-for="g in rel.groups" :key="g.label" class="log__group">
        <p class="log__label t-label">{{ g.label }}</p>
        <ul class="bullets">
          <li v-for="(item, i) in g.items" :key="i">{{ item }}</li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
/* date rail on the left, entries on the right — spec-sheet rhythm. The rail needs
   12rem (the widest month-name date measures ~174px) and the entries take the rest
   of the column the page hands us. */
.log__rel {
  display: grid;
  grid-template-columns: 12rem 1fr;
  gap: var(--space-5);
  padding-top: var(--space-5);
  border-top: 1px solid var(--line);
}
.log__date {
  align-self: start;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.log__title {
  font-weight: 400;
}

.log__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}
.log__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.log__label {
  color: var(--ink-2);
}
/* the list, its marks, its ink and its measure are the shared `.bullets` (main.scss) —
   the same list the prose sections of both pages are, so it is literally the same rule
   rather than a hand-copy that had drifted in size, position and measure */

@media (max-width: $bp-stack) {
  .log__rel {
    grid-template-columns: 1fr;
    gap: var(--space-3);
  }
}
</style>
