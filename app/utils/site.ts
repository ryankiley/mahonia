// Single source of truth for the handful of strings that would otherwise drift
// across the footer and the legal pages. Nuxt auto-imports everything in
// app/utils, so app code can use these bare.
//
// Keep this file FREE OF HEAVY IMPORTS: the root app.vue consumes it, so
// anything it pulls in lands in the entry chunk (the editor SEO helper lives in
// utils/editorSeo.ts for exactly that reason). The one import below is a
// constants-only module with no imports of its own, so it costs the entry chunk
// a string.

// Public contact / takedown address. Doubles as the Terms abuse address.
// A Cloudflare Email Routing alias that forwards to a real inbox, so the published
// address belongs to the project rather than to a person — and can be repointed
// without touching the legal pages.
export const CONTACT_EMAIL = "hello@mahonia.app";

// Canonical production origin. Used where a request-derived origin doesn't
// exist or lies: PRERENDERED routes (the build crawler's request origin is
// http://localhost, which would bake broken absolute URLs into the static
// HTML) and the static social-card fallback in nuxt.config.
//
// RE-EXPORTED, not declared: the SERVER needs this same value to decide which
// host a sign-in link may point at, and it can't reach app/utils. The
// declaration moved to shared/site.ts so there is one copy; app code keeps
// using it bare, unchanged.
export { CANONICAL_ORIGIN } from "~~/shared/site";
