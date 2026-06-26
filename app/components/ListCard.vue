<script setup lang="ts">
import type { DiscoveryCard } from "~~/shared/discovery";
import { formatWeight } from "~~/shared/weights";

// A discovery feed card. Monochrome chrome; the ONLY colour is the category
// sparkline (the data viz, --cat-*). Weight is shown only when present. Links to
// the public read view by slug — never an id or token.
const props = defineProps<{ card: DiscoveryCard }>();

// the feed shows one consistent unit (g→kg auto) so cards stay comparable,
// independent of each list's own display preference.
const sparkTotal = computed(() => props.card.spark.reduce((s, x) => s + x.mg, 0));

const meta = computed(() => {
  const out: string[] = [`${props.card.itemCount} ${props.card.itemCount === 1 ? "item" : "items"}`];
  if (props.card.tripTypeLabel) out.push(props.card.tripTypeLabel);
  if (props.card.seasonLabel) out.push(props.card.seasonLabel);
  return out;
});
</script>

<template>
  <NuxtLink :to="`/l/${card.slug}`" class="lcard">
    <span class="lcard__title t-title">{{ card.title || "Untitled list" }}</span>

    <span class="lcard__meta t-sm t-muted">{{ meta.join(" · ") }}</span>

    <!-- category sparkline — the one colour on the card (data viz) -->
    <span v-if="card.spark.length && sparkTotal > 0" class="lcard__spark" role="img" aria-label="Weight by category">
      <span
        v-for="(s, i) in card.spark"
        :key="i"
        class="lcard__seg"
        :style="{ flexGrow: s.mg, background: `var(--cat-${s.colorKey})` }"
        :title="s.name"
      />
    </span>

    <span class="lcard__foot">
      <span v-if="card.hasWeights" class="t-num lcard__weight">
        {{ formatWeight(card.baseWeightMg > 0 ? card.baseWeightMg : card.totalWeightMg, "g") }}
        <span class="t-sm t-muted">{{ card.baseWeightMg > 0 ? "base" : "total" }}</span>
      </span>
      <span v-else class="t-sm t-muted">no weights</span>
    </span>
  </NuxtLink>
</template>

<style scoped>
/* de-outlined: a quiet raised surface, no border — separation from whitespace */
.lcard {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  background: var(--paper-2);
  color: var(--ink);
  transition: background var(--dur) var(--ease);
}
.lcard:hover {
  background: var(--paper-3);
}
.lcard__title {
  /* keep cards even — clamp long titles to two lines */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.lcard__meta {
  min-height: 1.2em;
}
.lcard__spark {
  display: flex;
  gap: var(--space-px);
  height: var(--bar-h);
  margin-top: var(--space-1);
}
.lcard__seg {
  flex-basis: 0;
  min-width: var(--bar-seg-min);
}
.lcard__foot {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-top: var(--space-1);
}
.lcard__weight {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: var(--text-title);
}
</style>
