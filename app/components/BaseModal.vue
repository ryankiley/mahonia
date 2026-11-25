<script setup lang="ts">
// Shared modal shell — the centered dialog over a fading scrim used by every
// dialog (catalog correction, the account, the feedback box). Owns the overlay, the scrim/rise
// transition, click-outside, Escape-to-close, and focus (move in on open, Tab
// trap while open, restore on close — aria-modal declares the page inert, and
// the scrim blocks the pointer but not the keyboard, so the shell must keep
// focus inside itself); each caller fills the body via the default slot and
// reacts to `close`. The visual shell lives in atoms/dialog.scss so it stays
// identical across every modal.
const props = defineProps<{ open: boolean; label: string }>();
const emit = defineEmits<{ close: [] }>();

// an Escape a menu inside the dialog already handled closes that menu only (onKeyStroke)
onKeyStroke("Escape", () => props.open && emit("close"));

const dlg = useTemplateRef<HTMLDivElement>("dlg");
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Where focus goes back to. Usually the control that was pressed. A MENU ROW is the
// exception: its menu closed on the same press, so the row is gone by the time the
// dialog closes and focus fell to <body>. Then it is the menu's trigger (the ⋯), the
// first button in the menu's root, as useMenuDismiss has it for Escape.
let restoreEl: HTMLElement | null = null;
let menuTrigger: HTMLElement | null = null;
function restoreFocus() {
  const to = restoreEl?.isConnected ? restoreEl : menuTrigger?.isConnected ? menuTrigger : null;
  restoreEl = menuTrigger = null;
  // nothing was recorded: never opened, which is every server render (no document)
  if (!to) return;
  // Focus that has already gone somewhere else stays there: another dialog this one's
  // action opened, or the page it navigated to.
  const active = document.activeElement;
  if (active && active !== document.body && !dlg.value?.contains(active)) return;
  to.focus();
}
// `immediate`: dialogs are Lazy-mounted on first use already open (see `appear`
// below), so a plain watch would never fire for that first open
watch(
  () => props.open,
  (open) => {
    if (open) {
      restoreEl = document.activeElement as HTMLElement | null;
      menuTrigger =
        restoreEl?.closest('[role="menu"]')?.closest(".menu")?.querySelector<HTMLElement>("button") ?? null;
      // nextTick: the dlg node exists only after this open renders. Yield if a
      // caller already placed focus inside (the link-fallback preselects its
      // input). reset.scss suppresses the container's non-keyboard focus ring.
      nextTick(() => {
        const el = dlg.value;
        if (el && !el.contains(document.activeElement)) el.focus();
      });
    } else restoreFocus();
  },
  { immediate: true },
);
// a dialog its parent mounts with v-if (People) is never told it closed
onBeforeUnmount(() => props.open && restoreFocus());

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
