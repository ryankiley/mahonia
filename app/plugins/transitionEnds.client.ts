// A TRANSITION THAT ENDED AFTER NO TIME DID NOT END.
//
// Vue's <Transition> takes an element out when it has heard as many `transitionend`
// events on it as the leave has properties (two for a menu: opacity and transform). It
// does not ask what those events were. While a finger is dragging the page, Chromium
// fires `transitionend` with an elapsedTime of exactly 0 on a transition it has just
// started — in the same instant as its `transitionrun` — and then goes on to draw the
// whole fade. Vue heard its two ends and removed the menu one frame into a 234ms exit.
//
// That is the "blip": a drag is how a phone dismisses every menu (useMenuDismiss, so a
// card isn't left parked over the page), and about four dismissals in ten went in one
// frame (Ryan, 2026-11-25: "scrolling causes them to blip out … on mobile at least").
// Measured in emulated-touch Chromium over the built site: with these events kept from
// Vue, every exit runs its length and the browser draws 1 → 0.61 → 0.25 → 0.09. A mouse
// click away never produced one in 12 tries.
//
// So they are stopped here, once, ahead of every listener, for every <Transition> in the
// app rather than a `:duration` restated in script on each of the fourteen menus. A real
// end always reports its own duration, which is never 0: under reduced motion it is
// 0.01ms (main.scss) and passes, and from the keyboard there is no transition and no
// event at all (atoms/modality.scss). Vue's own timer, one millisecond past the computed
// duration, still takes the element out if the true end never comes.
export default defineNuxtPlugin(() => {
  window.addEventListener(
    "transitionend",
    (e) => {
      if (e.elapsedTime === 0) e.stopImmediatePropagation();
    },
    { capture: true },
  );
});
