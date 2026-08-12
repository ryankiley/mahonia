// The security surface: the one external host, the Content-Security-Policy built
// from it, and the headers every route carries.
//
// Lifted out of nuxt.config.ts so it can be IMPORTED. tests/csp.test.ts is the
// reason: it is the file that keeps this policy honest, and to read these values it
// had to readFileSync nuxt.config.ts and pull them out with regexes — parsing the
// CSP array out of source text and interpolating TILE_ORIGIN by hand, with an
// assertion whose failure message was "did the CSP block move?". A test that can
// be broken by reformatting the thing it guards is a weak guard. Now it imports
// them.
//
// Build-time config, so it lives here rather than in shared/ (which means the
// browser and the server both need it while serving a request) or server/utils/
// (request-time helpers). nuxt.config.ts is the only runtime consumer.

// The one host this site talks to besides itself: the basemap under a planned route.
//
// Settled by putting the same walk on eight of them, live and side by side, rather than by
// reasoning about it. Three were rejected for what they showed:
//
//   - Bare hillshade is beautiful and says NOTHING — no water, no trails, no names. A map
//     with no information on it is a texture.
//   - A street map has no relief at all, so a mountain reads as a blank.
//   - A satellite image shows real ground cover and no elevation, names or trails.
//
// OpenTopoMap is the densest option and it won on the thing that actually matters up a
// mountain: contours you can count, every stream, every named glacier and spur, and the
// trails themselves. It is drawn for walking, which none of the others are.
//
// What that costs is legibility, and it is paid for in RouteMap rather than by choosing a
// quieter map: the route is drawn with a white casing under it so it stays the loudest
// mark on a busy ground. Note the collision that made that necessary — this style draws
// paths in MAGENTA, which is within a few degrees of the hue day 2 wears.
//
// No account and no API key, so there is nothing to leak in the client and nothing to
// rotate. Swapping provider is this constant plus the tile URL and attribution in
// RouteMap.client.vue — and the alternatives that keep coming up (MapTiler, Tracestrack)
// all want an account, a public key, a monthly ceiling and their own branding, which is
// four new constraints in exchange for one. Esri's unkeyed topo is the closest same-shape
// fallback (server.arcgisonline.com, World_Topo_Map/MapServer/tile/{z}/{y}/{x} — note the
// AXIS ORDER differs), quieter but with no trails on it.
//
// TRIPWIRE, and this one is live rather than hypothetical: OpenTopoMap is free for
// NON-COMMERCIAL use and restricted above roughly 400k tiles a month. That fits today —
// legal.vue says "No advertising, and I don't sell your data" — but if either fact
// changes, the basemap must be revisited BEFORE it ships, not after a block. The same
// policy is why the tile layer caps maxZoom at 17, keeps the attribution control, and
// never fetches a tile it isn't about to draw.
//
// WHEN IT TRIPS, THE ANSWER IS MAPBOX'S RASTER TILES API — written down here so the next
// reader doesn't re-derive it and get it wrong. Mapbox GL JS is disqualified: ~200 KB in
// one chunk against a 72 KB ceiling, plus WebGL, workers and `connect-src`. Its RASTER
// endpoint is none of that — it is <img> tiles like these, so Leaflet stays, the bundle
// stays, and the CSP delta stays exactly one host in `img-src`. 750k tile requests a month
// free (~15k map opens at ~50 tiles each), then $0.25 per 1,000, and no non-commercial
// clause. The costs are an account, a public token in the tile URL — restrict it by URL,
// which works because the layer already sends `referrerPolicy: "origin"` for OpenTopoMap's
// sake — and a failure mode that becomes a BILL rather than a block. That last one is the
// reason this isn't the default today.
//
// WHAT IS NOT AN OPTION, whatever its cartography or price: anything that puts THIRD-PARTY
// SCRIPT in the page. Apple MapKit JS is the live example — it must be loaded from Apple's
// CDN, so it needs `script-src https://…`. A list's edit capability lives in the URL
// FRAGMENT (`/e/{code}#{token}`), and any script in the page can read `location.hash`.
// That is a capability leak, not a preference, and no map is worth it.
export const TILE_ORIGIN = "https://tile.opentopomap.org";

// Content-Security-Policy — defense-in-depth for a public, anyone-can-write app.
// `'unsafe-inline'` is required for script + style: Nuxt SSR/prerender emits inline
// bootstrap/payload scripts and Vue `:style` produces inline styles, and there's no
// per-request nonce for prerendered static files. Everything else is same-origin —
// Vercel Analytics injects `/_vercel/insights` (self), and the PWA service worker,
// fonts, and images are all served from our own origin.
//
// ONE exception, and deliberately only one: map tiles are `<img>`, so the basemap costs
// exactly one host in `img-src` and nothing else. `connect-src` stays `'self'` — which
// is the load-bearing half, and why place search (if it ever lands) must be proxied
// through our own server rather than called from the browser.
//
// `script-src` stays same-origin too, and that is not a style preference: the edit
// capability for a list lives in the URL fragment, and any third-party script in the
// page can read `location.hash`. A CDN <script> would be a capability leak, which is
// why Leaflet is bundled rather than linked.
//
// On the folder-colorKey `url()` beacon this used to backstop: the surface is now one
// extra host wide, and that is immaterial. A beacon that can only fire at a tile CDN
// tells an attacker nothing, because they cannot read its logs. The two real guards —
// SAFE_COLOR_KEY in the reducer and the re-check in categoryColor() — are untouched.
export const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `img-src 'self' data: blob: ${TILE_ORIGIN}`,
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join("; ");

export const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  // Keep the share code in `/e/{code}` out of the Referer. NOT the edit token — the
  // token lives in the fragment, and fragments are never sent in Referer by spec, so
  // this header was never what protected it. What it protects is the PATH.
  //
  // Map tiles are the one thing that opts partway back in, because tile providers
  // commonly authenticate or enforce their usage policy by Referer and would otherwise
  // refuse us: the tile layer sets `referrerPolicy: "origin"`, so a tile request carries
  // `https://mahonia.app/` and nothing else — no path, no share code. Strictly less than
  // the site's own outbound links already leak.
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY", // legacy clickjacking guard (frame-ancestors covers modern browsers)
};
