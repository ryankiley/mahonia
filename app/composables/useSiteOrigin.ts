// The absolute origin for URLs the page mints about itself (the social-card
// image, app.vue's static fallback) — request-derived so SSR routes reference
// their own deploy host, portable like the sitemap, no hardcoded URL.
//
// The guard exists for PRERENDERED routes (/e, the legal pages): the build
// crawler's request origin would bake a broken absolute http://localhost/… into
// the static HTML, so that one case pins the canonical origin instead. The
// crawler is identified by its PORTLESS http://localhost origin (a real local
// server always carries a port; import.meta.prerender is NOT substituted in app
// code — verified against the built output, which still carried localhost with
// it). Routes rendered per request never hit the guard — but they take it
// anyway, from here, so a route that later becomes prerendered (it has happened:
// /e/{code} once carried isr) is correct by construction rather than by a
// comment staying true.
export function useSiteOrigin(): string {
  const origin = useRequestURL().origin;
  return origin === "http://localhost" ? CANONICAL_ORIGIN : origin;
}
