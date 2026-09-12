import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEvent, type H3Event } from "h3";
import { describe, expect, it } from "vitest";
import robots from "../server/routes/robots.txt";
import llms from "../server/routes/llms.txt";

// The crawl rules, pinned. robots.txt and noindex do different jobs: robots says
// "don't fetch", noindex says "fetch, then don't list" — and noindex only works if
// the page can be fetched. /s share links are therefore fetchable and noindexed,
// not disallowed; a disallow turned away the user-initiated fetchers (an assistant
// someone pastes a share link into) that the rule was never aimed at, while doing
// nothing for search that the page's own noindex doesn't already do.

/** A minimal real H3 GET event, the shape passkeyCeremony's helper makes for POSTs. */
function getEvent(path: string, host = "mahonia.test"): H3Event {
  const req = new IncomingMessage(new Socket());
  req.method = "GET";
  req.url = path;
  req.headers = { host };
  req.push(null);
  return createEvent(req, new ServerResponse(req));
}

const rules = (body: string) => body.split("\n").filter((l) => /^(Allow|Disallow):/.test(l));

describe("robots.txt", () => {
  it("keeps the capability and API surfaces off-limits", async () => {
    const body = String(await robots(getEvent("/robots.txt")));
    expect(body).toMatch(/^User-agent: \*$/m);
    expect(rules(body)).toEqual(["Allow: /", "Disallow: /e", "Disallow: /mine", "Disallow: /api/"]);
  });

  it("does not disallow /s share links — they are noindex, not unfetchable", async () => {
    const body = String(await robots(getEvent("/robots.txt")));
    expect(body).not.toMatch(/^Disallow: \/s\b/m);
    expect(body).not.toMatch(/^Disallow: \/l\b/m);
  });

  it("points at the sitemap on the requesting host", async () => {
    const body = String(await robots(getEvent("/robots.txt", "lists.example")));
    expect(body).toMatch(/^Sitemap: http:\/\/lists\.example\/sitemap\.xml$/m);
  });
});

describe("llms.txt", () => {
  it("tells a fetcher that a share link is readable, and not listed", async () => {
    const body = String(await llms(getEvent("/llms.txt")));
    expect(body).toContain("/s/{code}");
    expect(body).toMatch(/noindex/);
    expect(body).toContain("http://mahonia.test/about");
  });
});
