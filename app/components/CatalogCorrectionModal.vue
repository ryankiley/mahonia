<script setup lang="ts">
import { formatWeight, parseWeightInput } from "~~/shared/weights";

const { target, submitting, close, submit } = useCatalogCorrection();
const emit = defineEmits<{ done: [{ status: string; itemName?: string }] }>();

const weight = ref("");
const sourceUrl = ref("");
const reason = ref("");
const edited = ref(false); // did the user touch the weight field?
const weightField = useTemplateRef<HTMLInputElement>("weightField");

// prefill the user's current weight as the suggestion whenever the dialog opens —
// immediate, because this component is Lazy-mounted on first use, when the target
// is ALREADY set (a plain watch would never fire for that first open)
watch(
  target,
  (t) => {
    if (t) {
      weight.value = formatWeight(t.suggestedMg, t.displayUnit, { raw: true });
      sourceUrl.value = "";
      reason.value = "";
      edited.value = false;
    }
  },
  { immediate: true },
);
// The figure takes the caret, selected: it is the one thing this card asks for, and a
// typed number should replace the suggestion rather than join it. The NUMBER only, not
// its unit, so what is typed over it still reads as a weight in the unit beside it.
// On the node, post (see BaseModal's move-in): the field is made anew for each target,
// and on the first one it reaches the page after the tick a watch on `target` could wait.
watch(
  weightField,
  (el) => {
    if (!el) return;
    el.focus();
    const unitAt = weight.value.search(/\s/);
    el.setSelectionRange(0, unitAt < 0 ? weight.value.length : unitAt);
  },
  { flush: "post" },
);

async function onSubmit() {
  // if the field is untouched, send the EXACT integer mg (formatWeight→parse is
  // lossy and locale-dependent); only parse the string when the user edited it.
  // Parsed HERE, in the unit the card is showing, the way a row's weight field reads a
  // bare number in its row's unit. The server only ever sees the text, and reads a
  // figure with no unit as grams: on a list in ounces, "30" over "31.3 oz" proposed
  // thirty grams for everyone. A figure this can't read still goes as typed, so the
  // server's refusal is the answer.
  const asked = target.value;
  const typedMg = edited.value && asked ? parseWeightInput(weight.value, asked.displayUnit) : null;
  const res = await submit({
    weight: edited.value && typedMg === null ? weight.value : undefined,
    weightMg: edited.value ? (typedMg ?? undefined) : target.value?.suggestedMg,
    sourceUrl: sourceUrl.value.trim() || undefined,
    reason: reason.value.trim() || undefined,
  });
  if (!res) return;
  emit("done", res);
  // cancelled and reopened on another item while this was out: that dialog isn't ours
  if (target.value === asked) close();
}
</script>

<template>
  <BaseModal :open="!!target" label="Fix catalog weight" @close="close()">
    <template v-if="target">
      <h2 class="t-label panel__title">Fix catalog weight</h2>
      <p class="dlg__item">{{ target.itemName }}</p>
      <p class="t-muted dlg__lede">
        The catalog says {{ formatWeight(target.catalogWeightMg, target.displayUnit) }}. A fix
        here changes it for everyone, not just your list.
      </p>

      <label class="dlg__field">
        <span class="t-muted">Correct weight</span>
        <input ref="weightField" v-model="weight" class="field" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" @input="edited = true" @keydown.enter="onSubmit" />
      </label>
      <label class="dlg__field">
        <span class="t-muted">Source link <em>(a maker’s or shop’s page applies it right away)</em></span>
        <input v-model="sourceUrl" class="field" placeholder="https://" inputmode="url" @keydown.enter="onSubmit" />
      </label>
      <label class="dlg__field">
        <span class="t-muted">Note (optional)</span>
        <input v-model="reason" class="field" maxlength="200" @keydown.enter="onSubmit" />
      </label>

      <div class="dlg__actions">
        <button class="btn btn--soft" @click="close()">Cancel</button>
        <button class="btn btn--primary" :disabled="submitting" @click="onSubmit">
          {{ submitting ? "Sending…" : "Suggest fix" }}
        </button>
      </div>
    </template>
  </BaseModal>
</template>

<style scoped>
/* overlay + dialog shell + rise-in + action row live in atoms/dialog.scss and
   BaseModal; this dialog keeps only its own item title and field accent */
/* the item's name at title size is .dlg__item — atoms/dialog.scss, shared with the
   vault-item dialog */
.dlg__field em {
  font-style: normal;
  color: var(--accent);
}
</style>
