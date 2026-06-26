<script setup lang="ts">
import { X } from "@lucide/vue";
import { formatWeight } from "~~/shared/weights";

const { target, submitting, close, submit } = useCatalogCorrection();
const emit = defineEmits<{ done: [{ status: string; itemName?: string }] }>();

const weight = ref("");
const sourceUrl = ref("");
const reason = ref("");
const edited = ref(false); // did the user touch the weight field?

// prefill the user's current weight as the suggestion whenever the dialog opens
watch(target, (t) => {
  if (t) {
    weight.value = formatWeight(t.suggestedMg, t.displayUnit);
    sourceUrl.value = "";
    reason.value = "";
    edited.value = false;
  }
});

async function onSubmit() {
  // if the field is untouched, send the EXACT integer mg (formatWeight→parse is
  // lossy and locale-dependent); only parse the string when the user edited it
  const res = await submit({
    weight: edited.value ? weight.value : undefined,
    weightMg: edited.value ? undefined : target.value?.suggestedMg,
    sourceUrl: sourceUrl.value.trim() || undefined,
    reason: reason.value.trim() || undefined,
  });
  if (res) {
    emit("done", res);
    close();
  }
}

onKeyStroke("Escape", () => target.value && close());
</script>

<template>
  <Transition name="ovl">
    <div v-if="target" class="ovl" @click.self="close()">
      <div class="dlg panel" role="dialog" aria-modal="true" aria-label="Fix catalog weight">
        <div class="dlg__top">
          <p class="t-label">Fix catalog weight</p>
          <button class="btn btn--icon btn--ghost dlg__close" title="Close" aria-label="Close" @click="close()">
            <X :size="16" />
          </button>
        </div>
        <p class="dlg__item">{{ target.itemName }}</p>
        <p class="t-sm t-muted dlg__lede">
          Catalog lists {{ formatWeight(target.catalogWeightMg, target.displayUnit) }}. Suggest the
          correct weight — this fixes it for everyone, not just your list.
        </p>

        <label class="dlg__field">
          <span class="t-sm t-muted">Correct weight</span>
          <input v-model="weight" class="field" inputmode="decimal" @input="edited = true" @keydown.enter="onSubmit" />
        </label>
        <label class="dlg__field">
          <span class="t-sm t-muted">Source link <em>— a manufacturer/retailer page applies it instantly</em></span>
          <input v-model="sourceUrl" class="field" placeholder="https://" inputmode="url" @keydown.enter="onSubmit" />
        </label>
        <label class="dlg__field">
          <span class="t-sm t-muted">Note (optional)</span>
          <input v-model="reason" class="field" maxlength="200" @keydown.enter="onSubmit" />
        </label>

        <div class="dlg__actions">
          <button class="btn btn--ghost" @click="close()">Cancel</button>
          <button class="btn btn--primary" :disabled="submitting" @click="onSubmit">
            {{ submitting ? "Sending…" : "Suggest fix" }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* overlay + dialog shell live in atoms/dialog.scss; this dialog adds a rise-in
   and its own header/actions */
.dlg {
  transition:
    transform var(--dur) var(--ease-spring),
    opacity var(--dur) var(--ease);
}
.dlg__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.dlg__close {
  margin: calc(-1 * var(--space-2)) calc(-1 * var(--space-2)) 0 0;
  color: var(--ink-3);
}
.dlg__close:hover {
  color: var(--ink);
}
.dlg__item {
  font-size: var(--text-title);
  font-weight: 600;
  letter-spacing: -0.02em;
}
.dlg__field em {
  font-style: normal;
  color: var(--accent);
}
.dlg__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
/* the dialog itself rises in (the scrim just fades) */
.ovl-enter-from .dlg {
  transform: translateY(12px);
  opacity: 0;
}
</style>
