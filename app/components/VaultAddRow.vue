<script setup lang="ts">
import type { Unit } from "~~/shared/types";
import type { NameCommit } from "~/composables/useCatalogSearch";

// The inline "add a piece of gear" pair on /gear — a name and a weight. Its own
// component because the page draws it in two places (under the count, and in the
// empty state), and an instance focuses itself on mount.
//
// The VALUES live on the page rather than here: a failed add has to leave your text
// where you typed it, and the page is what knows whether the request landed.
//
// The name is the list editor's own field (ItemInput), so typing offers the catalog the
// way a list row does, and picking a product adds it AS that product: brand, size, gear
// type, catalog link and weight in one press. Catalog-only (your own gear would only be
// offered back to you as a duplicate) and pick-only (typed text waits for this form's
// submit, weight and all, rather than committing when you tab across to the weight).
const props = defineProps<{ unit: Unit; busy?: boolean }>();
const emit = defineEmits<{
  submit: [];
  /** a catalog product picked from the name's suggestions */
  pick: [NameCommit];
  done: [];
}>();

const name = defineModel<string>("name", { required: true });
const weight = defineModel<string>("weight", { required: true });

const formEl = useTemplateRef<HTMLFormElement>("formEl");
/** Called by the page once an add has landed, to start the next one. (The field focuses
 *  itself on mount: press the label, land in the field.) */
defineExpose({ focus: () => formEl.value?.querySelector<HTMLInputElement>(".ac__input")?.focus() });
</script>

<template>
  <form ref="formEl" class="vaddrow" @submit.prevent="emit('submit')">
    <ItemInput
      class="vaddrow__name"
      :unit="props.unit"
      :initial="name"
      placeholder="Name"
      sources="catalog"
      pick-only
      well
      autofocus
      @draft="(v: string) => (name = v)"
      @commit="(c: NameCommit) => emit('pick', c)"
      @submit="emit('submit')"
      @keydown.esc="emit('done')"
    />
    <!-- A blank weight is allowed, and lands as 0. Gear you own but haven't weighed
         is a legitimate row here; isVaultWorthy's "still a half-typed thought" rule
         governs AUTOMATIC capture, where a weightless row really is someone
         mid-sentence. The unit is the placeholder rather than a label — the field is
         two inches under the total that names it. -->
    <input
      v-model="weight"
      class="field well vaddrow__weight"
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
