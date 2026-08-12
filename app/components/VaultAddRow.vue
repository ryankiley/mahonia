<script setup lang="ts">
import type { Unit } from "~~/shared/types";

// The inline "add a piece of gear" pair on /gear — a name and a weight.
//
// ITS OWN COMPONENT for two reasons. The page renders one of these per folder
// section, inside a v-for, and a template ref declared inside a v-for collects into
// an ARRAY — so focusing the field on open would have silently done nothing. An
// instance per position owns its own ref and focuses itself on mount. It also stops
// the same twenty lines existing three times over (a folder's row, a flat view's,
// and the empty state's).
//
// The VALUES live on the page rather than here: a failed add has to leave your text
// where you typed it, and the page is what knows whether the request landed.
const props = defineProps<{ unit: Unit; busy?: boolean }>();
const emit = defineEmits<{ submit: []; done: [] }>();

const name = defineModel<string>("name", { required: true });
const weight = defineModel<string>("weight", { required: true });

const nameEl = useTemplateRef<HTMLInputElement>("nameEl");
// press the label, land in the field — the affordance opened because you meant to type
onMounted(() => nameEl.value?.focus());
/** Called by the page once an add has landed, to start the next one. */
defineExpose({ focus: () => nameEl.value?.focus() });
</script>

<template>
  <form class="vaddrow" @submit.prevent="emit('submit')">
    <input
      ref="nameEl"
      v-model="name"
      class="field vaddrow__name"
      placeholder="Name"
      aria-label="Gear name"
      autocomplete="off"
      autocorrect="off"
      spellcheck="false"
      @keydown.esc="emit('done')"
    />
    <!-- A blank weight is allowed, and lands as 0. Gear you own but haven't weighed
         is a legitimate row here; isVaultWorthy's "still a half-typed thought" rule
         governs AUTOMATIC capture, where a weightless row really is someone
         mid-sentence. The unit is the placeholder rather than a label — the field is
         two inches under the total that names it. -->
    <input
      v-model="weight"
      class="field vaddrow__weight"
      :placeholder="props.unit"
      :aria-label="`Weight in ${props.unit}`"
      inputmode="decimal"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      @keydown.esc="emit('done')"
    />
    <!-- Submit, not a blur-commit: on a two-field form a blur commit makes tabbing
         between the fields ambiguous. Enter does the same thing, and re-opens a
         fresh pair, which is what makes typing in five things bearable. -->
    <button type="submit" class="btn btn--sm btn--quiet" :disabled="!name.trim() || props.busy">Add</button>
    <button type="button" class="btn btn--sm btn--quiet" @click="emit('done')">Done</button>
  </form>
</template>

<style scoped lang="scss">
.vaddrow {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-block: var(--space-1);
}
.vaddrow__name {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 24rem;
}
/* wide enough for "1.36" beside its unit placeholder, and no wider — a weight field
   that stretches reads as the more important of the two, which it isn't */
.vaddrow__weight {
  flex: none;
  width: 7rem;
  text-align: right;
}
@media (max-width: $bp-stack) {
  .vaddrow {
    flex-wrap: wrap;
  }
  .vaddrow__name {
    flex-basis: 100%;
    max-width: none;
  }
}
</style>
