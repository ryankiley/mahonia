<script setup lang="ts">
// The single mount point for the app-wide confirm + copy-link-fallback dialogs
// (state in useDialogs). Rendered once in app.vue so every page — including the
// layout-less editor — shares one instance. Both reuse BaseModal (scrim, rise,
// Escape + click-outside), so they look and behave like every other dialog.
const { confirmState, settleConfirm, linkState, closeLinkFallback } = useDialogs();

const linkInput = useTemplateRef<HTMLInputElement>("linkInput");
watch(
  () => linkState.open,
  (open) => {
    // pre-select the link so it's one keystroke to copy by hand
    if (open) nextTick(() => linkInput.value?.select());
  },
);
</script>

<template>
  <div>
    <BaseModal :open="confirmState.open" :label="confirmState.title || 'Confirm'" @close="settleConfirm(false)">
      <p v-if="confirmState.title" class="t-label">{{ confirmState.title }}</p>
      <p class="t-sm t-muted dlg__lede">{{ confirmState.message }}</p>
      <div class="dlg__actions">
        <button class="btn btn--ghost" @click="settleConfirm(false)">{{ confirmState.cancelLabel }}</button>
        <button class="btn btn--primary" @click="settleConfirm(true)">{{ confirmState.confirmLabel }}</button>
      </div>
    </BaseModal>

    <BaseModal :open="linkState.open" :label="linkState.title" @close="closeLinkFallback">
      <p class="t-label">{{ linkState.title }}</p>
      <p class="t-sm t-muted dlg__lede">Copying isn’t available here. Select the link below and copy it.</p>
      <input ref="linkInput" class="field dlg__linkfield" :value="linkState.url" readonly @focus="linkInput?.select()" />
      <div class="dlg__actions">
        <button class="btn btn--primary" @click="closeLinkFallback">Done</button>
      </div>
    </BaseModal>
  </div>
</template>

<style scoped>
/* the action row (.dlg__actions) is shared shell — it lives in atoms/dialog.scss */
.dlg__linkfield {
  width: 100%;
  /* the import textarea's language — quiet tinted well, rounded a concentric
     step inside the card (radius-3 − space-2), not a hairline box. No focus
     deepen: the field is readonly and arrives preselected. */
  border: 0;
  background: var(--paper-2);
  border-radius: calc(var(--radius-3) - var(--space-2));
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
}
</style>
