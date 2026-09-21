// The sitemap handler end to end: the home page, About, every public list from the
// database, and every catalog product page from the CSV — the last two from
// different sources, on the request's own host, and a share link never. Nothing ran
// the handler before this; the crawlerText canaries only read its source.
import { describe, expect, it, vi } from "vitest";
import sitemap from "../server/routes/sitemap.xml";
import { makeEvent } from "./helpers/http";

vi.mock("../server/utils/discoveryRepo", () => ({
  listPublicSlugs: async () => [
    { slug: "timberline-loop-abc123", updatedAt: "2026-09-01T12:00:00.000Z" },
    { slug: "no-date-list-def456", updatedAt: null },
  ],
}));
// the pages come from the server asset in production; here, straight from a map
vi.mock("../server/utils/catalogPages", () => ({
  catalogPages: async () =>
    new Map([
      ["durston/x-mid-2", { slug: "durston/x-mid-2" }],
      ["therm-a-rest/neoair-xlite-nxt", { slug: "therm-a-rest/neoair-xlite-nxt" }],
    ]),
}));

describe("sitemap.xml", () => {
  it("lists the site, the public lists and the catalog pages on the request's host", async () => {
    const event = makeEvent("/sitemap.xml");
    const body = String(await sitemap(event));
    const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([
      "http://mahonia.test/",
      "http://mahonia.test/about",
      "http://mahonia.test/l/timberline-loop-abc123",
      "http://mahonia.test/l/no-date-list-def456",
      "http://mahonia.test/catalog/durston/x-mid-2",
      "http://mahonia.test/catalog/therm-a-rest/neoair-xlite-nxt",
    ]);
    // a list carries its last change; a product page, built from a dateless CSV, does not
    expect(body).toContain("<loc>http://mahonia.test/l/timberline-loop-abc123</loc><lastmod>2026-09-01</lastmod>");
    expect(body).toContain("<loc>http://mahonia.test/catalog/durston/x-mid-2</loc></url>");
    expect(body).not.toContain("/s/");
    expect(event.node.res.getHeader("content-type")).toBe("application/xml; charset=utf-8");
  });
});
