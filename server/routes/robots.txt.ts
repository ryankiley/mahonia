import { defineEventHandler, getRequestURL, setHeader } from "h3";

// Hand-rolled robots.txt. Public, indexable surfaces (/ and the /l public lists)
// are allowed; the /e editor capability, /s share-read views, and /api are
// disallowed (also enforced per-response via X-Robots-Tag: noindex). References
// the sitemap on the same host so it works on any deploy domain.
export default defineEventHandler((event) => {
  const origin = getRequestURL(event).origin;
  setHeader(event, "Content-Type", "text/plain; charset=utf-8");
  setHeader(event, "Cache-Control", "public, max-age=0, s-maxage=86400");
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /e",
    "Disallow: /s/",
    "Disallow: /mine",
    "Disallow: /api/",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
});
