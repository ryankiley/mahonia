import { describe, expect, it } from "vitest";
import llms from "../server/routes/llms.txt";
import robots from "../server/routes/robots.txt";
import sitemap from "../server/routes/sitemap.xml";
import { makeEvent } from "./helpers/http";

// The two plain-text files a fetcher reads before it reads anything else, and the
// one thing about them that is easy to get wrong in either direction.
//
// A share link is kept out of search by the page's own noindex, NOT by robots.txt.
// The two are not interchangeable: a robots block stops the crawler fetching the
// page, so it never reads the noindex, and can still index the bare URL from a link
// elsewhere. It also stops every well-behaved user-initiated fetcher (an assistant
// asked to read a pasted share link) before it reads a byte, which is what people
// noticed. So robots.txt leaves /s open, and that is safe only for as long as the
// page keeps its tag. This file holds the robots half; the other half, every share
// surface saying noindex itself, is held where each one runs: the pages in
// shareNoIndexPages.nuxt.test.ts, the APIs and social cards in shareNoIndex.test.ts,
// the Markdown twin in shareMarkdown.test.ts and the connector in mcp.test.ts.

describe("robots.txt", () => {
  it("keeps the capability, redirect and API paths out, and lets a share link be fetched", async () => {
    const event = makeEvent("/robots.txt");
    const body = String(await robots(event));
    const lines = body.split("\n");
    expect(lines).toContain("User-agent: *");
    expect(lines).toContain("Allow: /");
    expect(lines).toContain("Disallow: /e");
    expect(lines).toContain("Disallow: /mine");
    expect(lines).toContain("Disallow: /api/");
    // no rule of any spelling touches /s: not "/s", not "/s/", not "/s/*"
    expect(lines.filter((l) => /^Disallow:\s*\/s(\/|\*|$)/.test(l))).toEqual([]);
    // nor /mcp: the endpoint says noindex itself on every answer, and a fetcher a
    // person points at it should read its 405 body rather than a robots refusal
    expect(lines.filter((l) => /^Disallow:\s*\/mcp/.test(l))).toEqual([]);
    // the host comes from the request, so any deploy domain names its own sitemap
    expect(lines).toContain("Sitemap: http://mahonia.test/sitemap.xml");
    expect(event.node.res.getHeader("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("…and a sitemap that lists no list, only the pages meant to be found", () => {
    const body = String(sitemap(makeEvent("/sitemap.xml")));
    const locs = [...body.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(["http://mahonia.test/", "http://mahonia.test/about", "http://mahonia.test/help"]);
  });
});

describe("llms.txt", () => {
  it("names the share page and its Markdown twin as readable, on the request's host", async () => {
    const body = String(await llms(makeEvent("/llms.txt")));
    expect(body).toContain("http://mahonia.test/s/{code}: the list as a page");
    expect(body).toContain("http://mahonia.test/s/{code}.md: the same list as Markdown, served as plain text");
    // and still steers a fetcher away from the editor shell, which serves it nothing
    expect(body).toContain("The list editor (/e)");
    expect(body).toContain("http://mahonia.test/about");
    expect(body).toContain("https://github.com/ryankiley/mahonia/releases");
  });
});
