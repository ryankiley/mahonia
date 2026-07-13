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
/* shared dialog action row — trailing-aligned buttons, matching the import dialog */
.dlg__actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.dlg__linkfield {
  width: 100%;
  border: 1px solid var(--line-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
}
</style>
