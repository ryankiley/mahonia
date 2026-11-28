<script setup lang="ts">
import { IconFormSquare, IconSquareCheck } from "~/icons/central";
import { SvgIcon } from "~/utils/icon";
// The single mount point for the app-wide confirm + copy-link-fallback dialogs
// (state in useDialogs). Rendered once by AppOverlays so every page — including the
// layout-less editor — shares one instance. Both reuse BaseModal (scrim, rise,
// Escape + click-outside), so they look and behave like every other dialog.
const { confirmState, settleConfirm, linkState, closeLinkFallback } = useDialogs();

// The link is selected as its field reaches the page, so it's one keystroke to copy by
// hand. On the field and not on `open`: this component mounts on first use with the
// fallback already open, which a watch on `open` never hears, and the field is made anew
// on every open (BaseModal's move-in follows its card the same way).
const linkInput = useTemplateRef<HTMLInputElement>("linkInput");
watch(linkInput, (el) => el?.select(), { flush: "post" });
</script>

<template>
  <div>
    <BaseModal :open="confirmState.open" :label="confirmState.title || 'Confirm'" @close="settleConfirm(false)">
      <h2 v-if="confirmState.title" class="t-label panel__title">{{ confirmState.title }}</h2>
      <p class="t-muted dlg__lede">{{ confirmState.message }}</p>
      <!-- the optional second decision, asked here rather than in a follow-up dialog -->
      <label v-if="confirmState.checkboxLabel" class="dlg__opt">
        <span class="check">
          <input v-model="confirmState.checked" type="checkbox" class="check__box" />
          <SvgIcon :icon="IconFormSquare" class="check__icon check__icon--empty" aria-hidden="true" />
          <SvgIcon :icon="IconSquareCheck" class="check__icon check__icon--check" aria-hidden="true" />
        </span>
        <span class="dlg__opttext">
          {{ confirmState.checkboxLabel }}
          <span v-if="confirmState.checkboxHint" class="t-muted dlg__opthint">{{ confirmState.checkboxHint }}</span>
        </span>
      </label>
      <div class="dlg__actions">
        <button class="btn btn--soft" @click="settleConfirm(false)">Cancel</button>
        <button class="btn btn--primary" @click="settleConfirm(true)">{{ confirmState.confirmLabel }}</button>
      </div>
    </BaseModal>

    <BaseModal :open="linkState.open" :label="linkState.title" @close="closeLinkFallback">
      <h2 class="t-label panel__title">{{ linkState.title }}</h2>
      <p class="t-muted dlg__lede">Copying isn’t available here. Select the link below and copy it.</p>
      <input ref="linkInput" class="field well dlg__linkfield" :value="linkState.url" readonly @focus="linkInput?.select()" />
      <div class="dlg__actions">
        <button class="btn btn--primary" @click="closeLinkFallback">Done</button>
      </div>
    </BaseModal>
  </div>
</template>

<style scoped>
/* the action row (.dlg__actions) is shared shell — it lives in atoms/dialog.scss */
.dlg__linkfield {
  /* the import textarea's language: the .well atom's tinted ground and concentric
     corner, not a hairline box. The atom's ground and not --background-secondary, which
     sat at 1.10:1 on this card's float surface: a box you could not see around the one thing
     the dialog asks you to copy. Only the height is this field's; the type size is
     .field's own static 16px. */
  padding-block: var(--space-2);
}
</style>
