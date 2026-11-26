<script setup lang="ts">
import { IconCrossMedium } from "~/icons/central";
import { SvgIcon } from "~/utils/icon";
// The account, centred over whatever you were doing.
//
// Body and shell are both borrowed, deliberately: BaseModal owns the scrim, the rise,
// click-outside, Escape, the focus trap and focus restore, and AccountView is the same
// panel /authorize sets inline as a step. This file is the wiring between them and
// nothing else.
const { state, close } = useAccountModal();
// The title, and the dialog's accessible name with it, are the panel's own heading
// (v-model:heading): it knows whether it is a sign-in, a link just sent or the account,
// and a screen reader announcing one over another is the same mismatch as the title
// showing it. Until the panel has said, the half of its rule that needs no panel: a
// presumed account (offline, hint present) is still "your account", loading, rather
// than a sign-in you don't need.
const { presence } = useSession();
const heading = ref<string>();
const label = computed(() => heading.value ?? (presence.value !== "signedOut" ? "Your account" : "Sign in or sign up"));
// SIGNED OUT it is the sign-in card (SignInHead.vue): the mark, a centred
// title, and no close button to see. Signed in it is the account, a tall surface of
// sections that reads from the left under a title bar with its X: on a phone it leaves
// too little scrim to count on a press outside.
const card = computed(() => presence.value === "signedOut");
</script>

<template>
  <BaseModal :open="state.open" :label="label" @close="close">
    <!-- `done` is the panel telling us its errand finished: a sign-in or a sign-out
         landed. In this mount that means close. A deleted account does not
         fire it: the dialog stays open as Sign in, under the panel's confirmation. -->
    <!-- The only modal here whose body is a whole surface rather than a form, so it
         has no dlg__actions row and had no visible way out — just Escape and a tap on
         the scrim. The X is the same control the vault pane closes with. -->
    <SignInHead v-if="card">{{ label }}</SignInHead>
    <header v-else class="panel__head acctmodal__head">
      <!-- .t-label is --ink-2 by design; a panel TITLE steps up to full ink, which is
           what the sharing and vault headers already do. -->
      <h2 class="t-label panel__title">{{ label }}</h2>
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
        <SvgIcon :icon="IconCrossMedium" />
      </button>
    </header>
    <AccountView v-model:heading="heading" :notice="state.notice" @done="close" />
    <!-- After the form, so Tab reaches the field and Continue first; drawn only while it
         has keyboard focus, and always there for a screen reader. -->
    <button
      v-if="card"
      type="button"
      class="btn btn--icon btn--ghost signin__close"
      aria-label="Close"
      @click="close"
    >
      <SvgIcon :icon="IconCrossMedium" />
    </button>
  </BaseModal>
</template>

<style scoped>
/* the panels' header shape, to the pixel: title left, close right, no rule beneath.
   The negative top margin is theirs too — an icon button is taller than the line of
   type beside it, so without it the row sets the header's height and opens a gap the
   title doesn't need.
   The shape is the .panel__head atom (controls.scss); the offsets onto this
   container's edge are its own. */
.acctmodal__head {
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
   --icon-pull is that pull (tokens.scss, beside --tap-pull): derived from the box size
   rather than typed, so a retune of --icon-btn keeps the rhythm. */
.acctmodal__head .btn--icon {
  margin-block: var(--icon-pull);
}
/* touch: the button grows to --tap (atoms/controls.scss), so the pull that keeps the
   row as tall as its type is the --tap one. With the 32px pull on a 44px box the header
   stood 12px taller on a phone than the same header does under a mouse. */
@media (pointer: coarse) {
  .acctmodal__head .btn--icon {
    margin-block: var(--tap-pull);
  }
}
</style>
