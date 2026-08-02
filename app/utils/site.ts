// Single source of truth for the handful of strings that would otherwise drift
// across the footer and the legal pages. Nuxt auto-imports everything in
// app/utils, so app code can use these bare.
//
// Keep this file IMPORT-FREE: the root app.vue consumes it, so anything it
// pulls in lands in the entry chunk (the editor SEO helper lives in
// utils/editorSeo.ts for exactly that reason).

// Public contact / takedown address. Doubles as the Terms abuse address.
// A Cloudflare Email Routing alias that forwards to a real inbox, so the published
// address belongs to the project rather than to a person — and can be repointed
// without touching the legal pages.
export const CONTACT_EMAIL = "hello@mahonia.app";

// Canonical production origin. Used where a request-derived origin doesn't
// exist or lies: PRERENDERED routes (the build crawler's request origin is
// http://localhost, which would bake broken absolute URLs into the static
// HTML) and the static social-card fallback in nuxt.config. SSR routes keep
// deriving their origin from the live request (portable across deploy hosts).
export const CANONICAL_ORIGIN = "https://mahonia.app";
