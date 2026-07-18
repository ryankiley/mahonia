<script setup lang="ts">
// Shared modal shell — the centered dialog over a fading scrim used by every
// dialog (publish, catalog-correction). Owns the overlay, the scrim/rise
// transition, click-outside, Escape-to-close, and focus (move in on open, Tab
// trap while open, restore on close — aria-modal declares the page inert, and
// the scrim blocks the pointer but not the keyboard, so the shell must keep
// focus inside itself); each caller fills the body via the default slot and
// reacts to `close`. The visual shell lives in atoms/dialog.scss so it stays
// identical across every modal.
const props = defineProps<{ open: boolean; label: string }>();
const emit = defineEmits<{ close: [] }>();

onKeyStroke("Escape", () => props.open && emit("close"));

const dlg = useTemplateRef<HTMLDivElement>("dlg");
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

let restoreEl: HTMLElement | null = null;
// `immediate`: dialogs are Lazy-mounted on first use already open (see `appear`
// below), so a plain watch would never fire for that first open
watch(
  () => props.open,
  (open) => {
    if (open) {
      restoreEl = document.activeElement as HTMLElement | null;
      // nextTick: the dlg node exists only after this open renders. Yield if a
      // caller already placed focus inside (the link-fallback preselects its
      // input). reset.scss suppresses the container's non-keyboard focus ring.
      nextTick(() => {
        const el = dlg.value;
        if (el && !el.contains(document.activeElement)) el.focus();
      });
    } else if (restoreEl) {
      // the invoker may have unmounted while the dialog was up
      if (restoreEl.isConnected) restoreEl.focus();
      restoreEl = null;
    }
  },
  { immediate: true },
);

// cycle Tab between the dialog's first/last focusable descendants
function onTab(e: KeyboardEvent) {
  if (e.key !== "Tab" || !dlg.value) return;
  const els = dlg.value.querySelectorAll<HTMLElement>(FOCUSABLE);
  const first = els[0];
  const last = els[els.length - 1];
  if (!first || !last) return void e.preventDefault();
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === dlg.value)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
</script>

<template>
  <!-- `appear`: dialogs are Lazy-mounted on first use (already open), so the
       scrim/rise must also play on the component's initial render, not just on a
       later false→true toggle -->
  <Transition name="ovl" appear>
    <div v-if="open" class="ovl" @click.self="emit('close')">
      <div
        ref="dlg"
        class="dlg"
        role="dialog"
        aria-modal="true"
        :aria-label="label"
        tabindex="-1"
        @keydown="onTab"
      >
        <slot />
      </div>
    </div>
  </Transition>
</template>
