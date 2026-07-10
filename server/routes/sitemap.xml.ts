import { defineEventHandler, getRequestURL, setHeader } from "h3";
import { listPublicSlugs } from "../utils/discoveryRepo";

// Hand-rolled sitemap (no module / dep): the home page + every public list
// (/l/{slug}), gated by the public-discovery visibility rule (public, active,
// not flagged/deleted, non-empty — see discoveryRepo's
// publicVisibilityConditions). The host comes from the request, so
// it works on any deploy domain without configuring a canonical URL. The /e
// editor and /s share views are intentionally excluded (noindex capabilities).
const esc = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

export default defineEventHandler(async (event) => {
  const origin = getRequestURL(event).origin;
  const rows = await listPublicSlugs().catch(() => []);
  const urls = [
    `  <url><loc>${esc(origin)}/</loc></url>`,
    ...rows.map((r) => {
      const d = r.updatedAt ? new Date(r.updatedAt) : null;
      const lastmod = d && !isNaN(d.getTime()) ? `<lastmod>${d.toISOString().slice(0, 10)}</lastmod>` : "";
      return `  <url><loc>${esc(origin)}/l/${esc(r.slug)}</loc>${lastmod}</url>`;
    }),
  ];
  setHeader(event, "Content-Type", "application/xml; charset=utf-8");
  setHeader(event, "Cache-Control", "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
});
