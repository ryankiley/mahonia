<script setup lang="ts">
// The read views' top bar: the site bar, packed compact, carrying the one thing a
// reader is most likely to want (a list of their own) and the ⋯ of everything else.
import { Backpack02Icon, Route02Icon } from "@hugeicons/core-free-icons";
import type { ListSnapshot, Totals } from "~~/shared/types";

const props = defineProps<{
  snapshot: ListSnapshot | null;
  totals: Totals | null;
}>();

// Two modes, not the editor's three. Packing is absent because it is impossible here: a
// tick is the owner's list data, a viewer holds no edit token, and every checkbox would
// either fail or write to somebody else's list.
const view = useReadView();
const VIEW_MODES = [
  { key: "gear", label: "Gear", icon: Backpack02Icon },
  { key: "trip", label: "Trip", icon: Route02Icon },
] as const;
// Only when there is a choice to make. A list with no trip keeps exactly the bar it had
// before this existed — one mode is not a switcher, it is furniture.
const hasTrip = computed(
  () => (props.snapshot?.days?.length ?? 0) > 0 || !!props.snapshot?.trailProfile,
);
</script>

<template>
  <SiteTopbar compact>
    <NuxtLink to="/" class="btn btn--link">Make your own</NuxtLink>
    <!-- ⋯ goes in #end so it lands after the account glyph, matching the editor's
         bar (vault, account, share, ⋯). The reader's one text action keeps the
         lead; the two glyphs close the row. -->
    <template #end>
      <ReadonlyMenu v-if="snapshot" :snapshot="snapshot" :totals="totals" />
    </template>
    <template v-if="hasTrip" #below>
      <ModeBar :modes="VIEW_MODES" :current="view" label="View" @pick="(k) => (view = k as 'gear' | 'trip')" />
    </template>
  </SiteTopbar>
</template>
