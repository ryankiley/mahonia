<!-- The head of THE SIGN-IN CARD: the mark and a centred title, and with it everything
     that makes a dialog that card (the styles below).

     Signing in is the one dialog that is not a question about the page under it. It is a
     small front door, so it is drawn as one (the mark, a centred title, a line, and
     controls the card's width), where every other dialog reads from the left under a
     title bar. Three things wear it: the signed-out account dialog (AccountModal), the
     questions a sign-in link asks (SignInLinkDialog), and the link page's own card while
     the server is slow (pages/auth/callback.vue). Each wrote this head out for itself.

     The title is the slot, so a caller can keep words together across a line break
     (.signin__keep). The dialog's accessible name stays the caller's `label`. -->
<template>
  <div class="signin__head">
    <MahoniaMark class="signin__mark" />
    <h2 class="t-title signin__title"><slot /></h2>
  </div>
</template>

<!-- NOT scoped, and here rather than in atoms/dialog.scss: these rules reach the dialog
     around the head (.dlg) and the body and buttons beside it, and they are needed only
     where this component is. In the atoms they were in the stylesheet every page loads
     first, for a card nothing draws before one of its own chunks has arrived. -->
<style lang="scss">
/* There is no close button to see. The card is short, the scrim around it is most of
   the window, and Escape and a press outside both close it; .signin__close keeps a
   real button for a screen reader and for the keyboard, drawn only while it has focus. */
.dlg:has(> .signin__head) {
  position: relative;
  max-width: var(--account-measure);
  /* rounder than the other dialogs, to sit with the pills inside it (tokens.scss) */
  border-radius: var(--radius-5);
}
.signin__head {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  /* the mark's own top air: the card's padding alone set it against the edge */
  padding-block-start: var(--space-2);
  text-align: center;
}
.signin__mark {
  display: block;
  height: calc(40 * var(--tpx));
  width: auto;
}
/* the type is .t-title's, on the element; this is only what an address in a title needs */
.signin__title {
  overflow-wrap: anywhere;
}
/* words in a title that must not be parted by a line break */
.signin__keep {
  white-space: nowrap;
}
/* the card's body, where it is not the account form (which brings its own column): a
   line or two, then the buttons, each the card's width with the primary first */
.signin__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  text-align: center;
  /* Balanced, as the app's other centred copy is (the gear pane's empty state, the
     vault's sent line). Body text is `pretty` (reset.scss), which only keeps a lone
     word off the last line: it left "for it." alone under two full lines, and centred,
     a short last line reads as a mistake where left-aligned it reads as rag. */
  text-wrap: balance;
}
.signin__actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-block-start: var(--space-3);
}
.signin__close {
  position: absolute;
  inset-block-start: var(--space-3);
  inset-inline-end: var(--space-3);
}
/* .visually-hidden's recipe (reset.scss), which it cannot wear: that class never lets go,
   and this one has to show itself when the keyboard reaches it */
.signin__close:not(:focus-visible) {
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
</style>
