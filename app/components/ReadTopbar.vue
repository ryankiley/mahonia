<script setup lang="ts">
// The read views' top bar: the site bar, packed compact, carrying the one thing a
// reader is most likely to want (a list of their own) and the ⋯ of everything else.
import type { ListSnapshot, Totals } from "~~/shared/types";

defineProps<{
  snapshot: ListSnapshot | null;
  totals: Totals | null;
}>();

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
  </SiteTopbar>
</template>
