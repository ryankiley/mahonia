import { defineEventHandler, getRequestURL, setHeader } from "h3";
// Hand-rolled sitemap (no module / dep): the pages meant to be found. A list is never
// one of them — the /e editor and the /s share views are capabilities (noindex), and
// there is no publishing, so nothing a person makes appears anywhere but at its own
// links. The host comes from the request, so it works on any deploy domain without
// configuring a canonical URL.
const esc = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
export default defineEventHandler((event) => {
  const origin = esc(getRequestURL(event).origin);
  const urls = ["/", "/about", "/help"].map((path) => `  <url><loc>${origin}${path}</loc></url>`);
  setHeader(event, "Content-Type", "application/xml; charset=utf-8");
  setHeader(event, "Cache-Control", "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
});
