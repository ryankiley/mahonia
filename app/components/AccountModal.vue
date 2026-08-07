<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
// The account, centred over whatever you were doing.
//
// Body and shell are both borrowed, deliberately: BaseModal owns the scrim, the rise,
// click-outside, Escape, the focus trap and focus restore, and AccountView is the same
// component /account renders. This file is the wiring between them and nothing else.
const { state, close } = useAccountModal();
// The dialog's accessible name tracks the same state its heading does — a screen
// reader announcing "Your account" over a sign-in form is the same mismatch.
const { signedIn } = useSession();
const label = computed(() => (signedIn.value ? "Your account" : "Sign in"));
</script>

<template>
  <BaseModal :open="state.open" :label="label" @close="close">
    <!-- `done` is the panel telling us its errand finished — a sign-in landed, or the
         account was deleted. In this mount that means close; on /account it means go
         somewhere, which is why the panel takes the mount as a prop. -->
    <!-- The only modal here whose body is a whole surface rather than a form, so it
         has no dlg__actions row and had no visible way out — just Escape and a tap on
         the scrim. The X is the same control the vault and sharing panels close with. -->
    <header class="acctmodal__head">
      <!-- .t-label is --ink-2 by design; a panel TITLE steps up to full ink, which is
           what the sharing and vault headers already do. -->
      <h2 class="t-label acctmodal__title">{{ label }}</h2>
      <!-- btn--flush-end is how the other two put their X in a repeatable place: it
           cancels the icon button's own inset so the GLYPH — not the 32px box around
           it — lands on the card's content edge. Same class, same result, and it
           survives the coarse-pointer growth because the pull is derived, not typed.
           A named label, like theirs, so "Close" alone isn't the whole announcement. -->
      <button
        type="button"
        class="btn btn--icon btn--ghost btn--flush-end"
        aria-label="Close your account"
        @click="close"
      >
        <HugeiconsIcon :icon="Cancel01Icon" :size="16" :stroke-width="2" />
      </button>
    </header>
    <AccountView in-modal hide-heading @done="close" />
  </BaseModal>
</template>

<style scoped>
/* the panels' header shape, to the pixel: title left, close right, no rule beneath.
   The negative top margin is theirs too — an icon button is taller than the line of
   type beside it, so without it the row sets the header's height and opens a gap the
   title doesn't need. */
.acctmodal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  /* the optical nudge the panels carry too: a line of type sits lower inside its box
     than a padding value suggests (half-leading plus the gap above the cap), so a
     header aligned by the box alone reads as more inset at the top than at the sides */
  margin-top: calc(-1 * var(--space-1));
  margin-bottom: var(--space-2);
}
/* The close button is --icon-btn (32px) tall against a 19.2px line of type, so left
   alone it SETS the header's height and centring pushes the title ~6px down — which is
   what made the top read as more padded than the sides even though .dlg insets both by
   --space-5. Pull the box back onto the text line so the title sits on the card's
   padding edge and the row is as tall as its type.
   Same shape as --tap-pull (tokens.scss), derived from the box size rather than typed,
   so a retune of --icon-btn keeps the rhythm. */
.acctmodal__head .btn--icon {
  margin-block: calc((1.45rem - var(--icon-btn)) / 2);
}
.acctmodal__title {
  color: var(--ink);
}
</style>
