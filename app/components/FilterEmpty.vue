<script setup lang="ts">
// The empty person-filter line — "Nothing is X’s yet." with the way back beside
// it — was one recipe written twice (editor + share view) with its own copy of
// the wrapping rule each time. Only a real person can reach it: both surfaces
// widen an emptied Unassigned view on their own before this ever renders.
defineProps<{ name: string }>();
defineEmits<{ clear: [] }>();
</script>

<template>
  <p class="t-sm t-muted filterempty">
    Nothing is {{ name }}’s yet.
    <button type="button" class="btn btn--quiet filterempty__clear" @click="$emit('clear')">Show everyone</button>
  </p>
</template>

<style scoped>
/* one quiet line where the folders would be, the way back beside it (ListMenu's
   "No lists match" voice). Wraps: a 60-char name folds the sentence at phone
   width, and without the wrap the button stayed pinned to the first line's
   baseline out at the right. */
.filterempty {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-3);
}
.filterempty__clear {
  flex: none;
}
</style>
