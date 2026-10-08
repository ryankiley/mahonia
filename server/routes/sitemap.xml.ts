import { defineEventHandler, getRequestURL, setHeader } from "h3";
import { catalogPages } from "../utils/catalogPages";
import { listPublicSlugs } from "../utils/discoveryRepo";
// Hand-rolled sitemap (no module / dep): the home page, every public list
// (/l/{slug}), gated by the public-discovery visibility rule (public, active,
// not flagged/deleted, non-empty — see discoveryRepo's
// publicVisibilityConditions), and every catalog product page (/catalog/{slug}),
// listed from the committed CSV rather than the database. The host comes from
// the request, so it works on any deploy domain without configuring a canonical
// URL. The /e editor and /s share views are intentionally excluded (noindex
// capabilities).
const esc = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
export default defineEventHandler(async (event) => {
  const origin = getRequestURL(event).origin;
  const rows = await listPublicSlugs().catch(() => []);
  // the CSV carries no dates, so the product pages get no <lastmod>: a crawler
  // that reads one as "unchanged" would be wrong more often than one that reads none
  const products = await catalogPages().catch(() => new Map());
  const urls = [
    `  <url><loc>${esc(origin)}/</loc></url>`,
    `  <url><loc>${esc(origin)}/about</loc></url>`,
    ...rows.map((r) => {
      const d = r.updatedAt ? new Date(r.updatedAt) : null;
      const lastmod = d && !isNaN(d.getTime()) ? `<lastmod>${d.toISOString().slice(0, 10)}</lastmod>` : "";
      return `  <url><loc>${esc(origin)}/l/${esc(r.slug)}</loc>${lastmod}</url>`;
    }),
    ...[...products.keys()].map((slug) => `  <url><loc>${esc(origin)}/catalog/${esc(slug)}</loc></url>`),
  ];
  setHeader(event, "Content-Type", "application/xml; charset=utf-8");
  setHeader(event, "Cache-Control", "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
});
