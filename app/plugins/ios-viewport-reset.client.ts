/**
 * Enforce minimum-scale=1 in JS — because iOS Safari deliberately IGNORES the
 * viewport-meta `minimum-scale` (since iOS 10 it always lets the user pinch-zoom,
 * an accessibility override). Pinching OUT below 100% grows Safari's layout
 * viewport to the wider visual viewport and it sticks, leaving a phantom right
 * margin (WebKit bug 240860/170981, engine-fixed only in Safari 26.5+). The
 * declarative `minimum-scale=1` in nuxt.config can't help on affected builds, so
 * we correct it at runtime: once a zoom gesture settles BELOW scale 1, snap the
 * page back to exactly 1 by momentarily clamping the viewport meta, then restore
 * the zoomable meta so pinch-zoom-IN keeps working.
 *
 * Why this is accessibility-safe: zoom-IN (scale > 1, the actual a11y need) is
 * never touched — we only act on scale < 1, and zooming out below 100% on a
 * width=device-width page reveals nothing anyway; it's purely the bug trigger.
 * It's also sticky-safe (no overflow / containing-block changes).
 */
export default defineNuxtPlugin(() => {
  const vv = window.visualViewport;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!vv || !meta) return;

  const ZOOMABLE = meta.content; // normal, pinch-zoom-enabled meta
  const CLAMP =
    "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, viewport-fit=cover";

  let settle: ReturnType<typeof setTimeout> | undefined;
  let restore: ReturnType<typeof setTimeout> | undefined;
  let clamping = false;

  vv.addEventListener("resize", () => {
    if (clamping) return; // ignore the resize our own clamp fires
    clearTimeout(settle);
    // wait for the pinch to finish, then correct only a sustained zoomed-OUT state
    settle = setTimeout(() => {
      if (vv.scale >= 0.999) return; // zoomed in or at 100% — leave it alone
      clamping = true;
      // re-applying the meta with min=max=1 forces Safari to re-clamp the live
      // scale back to 1 (the static min-scale it ignored now takes effect on change)
      meta.content = CLAMP;
      // a layout read to flush the clamp before we hand zoom back
      void document.documentElement.offsetWidth;
      clearTimeout(restore);
      restore = setTimeout(() => {
        meta.content = ZOOMABLE; // re-enable pinch-zoom-IN
        clamping = false;
      }, 100);
    }, 300);
  });
});
