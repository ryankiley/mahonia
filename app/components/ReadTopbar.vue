<script setup lang="ts">
import type { ListSnapshot, Totals } from "~~/shared/types";

// The read views' topbar chrome — "Make your own" plus the ⋯ menu — shared by
// /s/[code] and /l/[slug] so the block (and its print-hidden .topbar__actions
// class, targeted globally by print.scss) exists in exactly one place.
defineProps<{
  snapshot: ListSnapshot | null;
  totals: Totals | null;
}>();
</script>

<template>
  <SiteTopbar compact>
    <span class="topbar__actions">
      <NuxtLink to="/" class="btn btn--link">Make your own</NuxtLink>
      <ReadonlyMenu v-if="snapshot" :snapshot="snapshot" :totals="totals" />
    </span>
  </SiteTopbar>
</template>

<style scoped>
/* "Make your own" + the ⋯ menu travel together at the trailing edge (the wrapper
   takes the auto margin the topbar would otherwise give each .btn, spreading them) */
.topbar__actions {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
</style>
