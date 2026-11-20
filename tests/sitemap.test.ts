// The sitemap handler end to end: the site's own pages and every catalog product page
// from the CSV, on the request's own host, and a list never (there is no publishing).
// Nothing ran the handler before this; the crawlerText canaries only read its source.
import { describe, expect, it, vi } from "vitest";
import sitemap from "../server/routes/sitemap.xml";
import { makeEvent } from "./helpers/http";

// the pages come from the server asset in production; here, straight from a map
vi.mock("../server/utils/catalogPages", () => ({
  catalogPages: async () =>
    new Map([
      ["durston/x-mid-2", { slug: "durston/x-mid-2" }],
      ["therm-a-rest/neoair-xlite-nxt", { slug: "therm-a-rest/neoair-xlite-nxt" }],
    ]),
}));

describe("sitemap.xml", () => {
  it("lists the site and the catalog pages on the request's host", async () => {
    const event = makeEvent("/sitemap.xml");
    const body = String(await sitemap(event));
    const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([
      "http://mahonia.test/",
      "http://mahonia.test/about",
      "http://mahonia.test/help",
      "http://mahonia.test/catalog/durston/x-mid-2",
      "http://mahonia.test/catalog/therm-a-rest/neoair-xlite-nxt",
    ]);
    // a product page, built from a dateless CSV, carries no last change
    expect(body).toContain("<loc>http://mahonia.test/catalog/durston/x-mid-2</loc></url>");
    expect(body).not.toContain("/s/");
    expect(body).not.toContain("/l/");
    expect(event.node.res.getHeader("content-type")).toBe("application/xml; charset=utf-8");
  });
});
