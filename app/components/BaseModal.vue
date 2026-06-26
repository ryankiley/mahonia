<script setup lang="ts">
// Shared modal shell — the centered dialog over a fading scrim used by every
// dialog (publish, catalog-correction). Owns the overlay, the scrim/rise
// transition, click-outside, and Escape-to-close; each caller fills the body
// via the default slot and reacts to `close`. The visual shell lives in
// atoms/dialog.scss so it stays identical across every modal.
const props = defineProps<{ open: boolean; label: string }>();
const emit = defineEmits<{ close: [] }>();

onKeyStroke("Escape", () => props.open && emit("close"));
</script>

<template>
  <Transition name="ovl">
    <div v-if="open" class="ovl" @click.self="emit('close')">
      <div class="dlg panel" role="dialog" aria-modal="true" :aria-label="label">
        <slot />
      </div>
    </div>
  </Transition>
</template>
