<script setup lang="ts">
import { VAULT_TAB_LABEL, type VaultTab } from "~~/shared/vaultView";

// The line under a My Gear search that names the other tabs it matched
// (matchesElsewhere): "Nothing here matches “clif”. 2 on Food" when the open tab found
// nothing, "Also 2 on Food" under results. Each count is the way there, with the search
// still typed. One component for /gear and the list's panel, so the two say it in the
// same words; each surface only sizes and spaces it.
defineProps<{
  query: string;
  /** the open tab found nothing */
  none: boolean;
  matches: { tab: VaultTab; count: number }[];
}>();
const emit = defineEmits<{ pick: [tab: VaultTab] }>();
</script>

<template>
  <p>
    <template v-if="none">Nothing here matches “{{ query.trim() }}”.</template>
    <template v-else>Also</template>
    <template v-for="(m, i) in matches" :key="m.tab"
      >{{ i ? ", " : " " }}<button
        type="button"
        class="link elsewhere__go"
        :aria-label="`Show ${m.count} on ${VAULT_TAB_LABEL[m.tab]}`"
        @click="emit('pick', m.tab)"
      >{{ m.count }} on {{ VAULT_TAB_LABEL[m.tab] }}</button></template
    >
  </p>
</template>

<style scoped lang="scss">
/* a link in the sentence, not a control beside it: the sentence's own type, the site's
   text-link ink and underline (.link), no box */
.elsewhere__go {
  position: relative; /* the touch target below hangs off it */
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  text-decoration-line: underline;
  text-underline-offset: 0.2em;
  cursor: pointer;
}
/* a finger-sized target for a link drawn at text size: the box that answers the tap
   grows, the picture doesn't (the .switch::before trick, controls.scss) */
@media (pointer: coarse) {
  .elsewhere__go::before {
    content: "";
    position: absolute;
    inset-inline: 0;
    top: 50%;
    height: var(--tap);
    translate: 0 -50%;
  }
}
</style>
