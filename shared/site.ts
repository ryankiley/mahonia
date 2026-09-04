// The site's own identity — the handful of strings that describe WHERE Mahonia
// is, rather than what it does.
//
// In shared/ because both halves need it and neither can reach the other's copy:
// the browser renders CANONICAL_ORIGIN into absolute URLs on prerendered routes
// (app/composables/useSiteOrigin.ts), and the server needs the same value to
// decide what host a sign-in link may point at (server/utils/origin.ts). It used
// to live in app/utils/site.ts alone, which put it out of the server's reach —
// and a second copy on the server side is exactly the drift this file prevents.
//
// Constants only, no imports. app/utils/site.ts re-exports CANONICAL_ORIGIN so
// app code keeps its bare auto-import and the entry chunk still pulls in nothing
// but a string.

/**
 * The one address Mahonia is served from in production.
 *
 * Two jobs, and the second is a security control:
 *
 *   1. ABSOLUTE URLs WHERE THE REQUEST CAN'T SUPPLY ONE. Prerendered routes are
 *      built by a crawler whose request origin is http://localhost, so an
 *      og:image or canonical link derived from it would be baked broken into the
 *      static HTML.
 *
 *   2. THE ORIGIN A SIGN-IN LINK IS ALLOWED TO POINT AT. `Host` is a request
 *      header — anything on the far side of the socket can claim any value — so
 *      an emailed capability whose host came from the request is a capability
 *      addressed to whoever asked. See server/utils/origin.ts, which is the only
 *      place that decision is made.
 *
 * Overridable at runtime with MAHONIA_ORIGIN, which is what a fork or a
 * self-hosted deploy on another domain sets instead of editing this line.
 */
export const CANONICAL_ORIGIN = "https://mahonia.app";

/**
 * The edge-cache window for a list's read surfaces. One literal for the pair a
 * crawler fetches together — the read PAGES (/s, /l, via useResponseHeader) and
 * the API + card image behind them (server/utils/http.ts setReadEdgeCache) — so
 * they go stale together, which four copies of a header string can't promise. A
 * read-only view tolerates 30 s of staleness, and the window collapses the burst
 * when a share link makes the rounds.
 */
export const READ_EDGE_CACHE_CONTROL = "public, max-age=0, s-maxage=30, stale-while-revalidate=120";
