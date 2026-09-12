import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEvent, createError, type H3Event } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import shareMarkdown from "../server/middleware/shareMarkdown";
import { listToMarkdown } from "../shared/exporters/markdown";
import { encodePolyline } from "../shared/polyline";
import type { ListSnapshot } from "../shared/types";

// /s/{code}.md is the share page's Markdown twin, served by a middleware because the
// router can't express a suffix after a param (see the file). Driven here as a request
// would hit it: a real H3 event over bare node mocks, no server booted, the repo and
// the limiter stubbed. What lives ONLY at this layer, and is pinned:
//   • it answers exactly its own shape and steps aside for everything else, because
//     the share page is BEHIND it in the chain and a middleware that answered
//     /s/{code} would replace the page rather than sit beside it;
//   • the headers are the page's: text/markdown, noindex, the read views' edge window
//     on a hit and NOT on a miss;
//   • it spends the same public-read budget as /api/s, before the lookup;
//   • the body is listToMarkdown's, and a snapshot carrying a route leaks none of it.

const repo = vi.hoisted(() => ({ getByShareCode: vi.fn() }));
vi.mock("../server/utils/listRepo", () => ({ getByShareCode: repo.getByShareCode }));
const limiter = vi.hoisted(() => ({ rateLimit: vi.fn(async () => {}) }));
vi.mock("../server/utils/rateLimit", () => ({ rateLimit: limiter.rateLimit }));

/** A minimal real H3 event: a method, a URL and a host, which is all the
 *  middleware reads. No server boots — the event IS the interface under test. */
function makeEvent(url: string, method = "GET"): H3Event {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = url;
  req.headers = { host: "mahonia.test" };
  req.push(null);
  return createEvent(req, new ServerResponse(req));
}

const snap = (): ListSnapshot => ({
  shareCode: "ABC123",
  slug: "trip-a1b2c3",
  version: 1,
  isPublic: false,
  title: "Trip",
  displayUnit: "g",
  folders: [{ id: "f1", name: "Shelter", defaultClassification: "base", sortOrder: 0 }],
  items: [
    { id: "i1", folderId: "f1", name: "Zpacks Duplex", unitWeightMg: 538000, qty: 1, classification: null, sortOrder: 0 },
  ],
});

const header = (event: H3Event, name: string) => event.node.res.getHeader(name);

beforeEach(() => {
  repo.getByShareCode.mockReset();
  limiter.rateLimit.mockReset();
  limiter.rateLimit.mockResolvedValue(undefined);
});

describe("/s/{code}.md", () => {
  it("answers with the list as Markdown, under the share page's headers", async () => {
    repo.getByShareCode.mockResolvedValue(snap());
    const event = makeEvent("/s/ABC123.md");
    const body = await shareMarkdown(event);

    expect(body).toBe(`${listToMarkdown(snap())}\n`);
    expect(body).toContain("# Trip");
    expect(body).toContain("| Zpacks Duplex | 1 | 538 g |");
    expect(repo.getByShareCode).toHaveBeenCalledWith("ABC123");
    expect(header(event, "content-type")).toBe("text/markdown; charset=utf-8");
    expect(header(event, "x-robots-tag")).toBe("noindex");
    // the read views' one shared window (setReadEdgeCache), so the twin and the page
    // go stale together
    expect(header(event, "cache-control")).toBe("public, max-age=0, s-maxage=30, stale-while-revalidate=120");
  });

  it("spends the public-read budget, and spends it BEFORE the lookup", async () => {
    repo.getByShareCode.mockResolvedValue(snap());
    const event = makeEvent("/s/ABC123.md");
    await shareMarkdown(event);
    expect(limiter.rateLimit).toHaveBeenCalledWith(event, "public-read");
    expect(limiter.rateLimit.mock.invocationCallOrder[0]!).toBeLessThan(
      repo.getByShareCode.mock.invocationCallOrder[0]!,
    );
  });

  it("a refused budget never reaches the database, and caches nothing", async () => {
    limiter.rateLimit.mockRejectedValue(createError({ statusCode: 429, statusMessage: "Too many requests" }));
    const event = makeEvent("/s/ABC123.md");
    await expect(shareMarkdown(event)).rejects.toMatchObject({ statusCode: 429 });
    expect(repo.getByShareCode).not.toHaveBeenCalled();
    expect(header(event, "cache-control")).toBeUndefined();
  });

  it("404s an unknown code with the shared wording, and no cache window", async () => {
    repo.getByShareCode.mockResolvedValue(null);
    const event = makeEvent("/s/NOPE.md");
    await expect(shareMarkdown(event)).rejects.toMatchObject({ statusCode: 404, statusMessage: "Not found" });
    // noindex is set before anything can throw, like /api/s; the edge window only on a hit
    expect(header(event, "x-robots-tag")).toBe("noindex");
    expect(header(event, "cache-control")).toBeUndefined();
  });

  it("matches on the path alone, whatever the query string says", async () => {
    repo.getByShareCode.mockResolvedValue(snap());
    const body = await shareMarkdown(makeEvent("/s/ABC123.md?utm_source=chat"));
    expect(body).toContain("# Trip");
    expect(repo.getByShareCode).toHaveBeenCalledWith("ABC123");
  });

  it("answers a HEAD the way it answers a GET, so a fetcher can ask what it is", async () => {
    repo.getByShareCode.mockResolvedValue(snap());
    const event = makeEvent("/s/ABC123.md", "HEAD");
    await shareMarkdown(event);
    expect(header(event, "content-type")).toBe("text/markdown; charset=utf-8");
  });

  it.each([
    ["/s/ABC123", "the share page itself"],
    ["/s/ABC123.md/", "a trailing slash"],
    ["/s/ABC123.json", "another suffix"],
    ["/s/ABC123.MD", "the suffix in capitals"],
    ["/s/", "no code"],
    ["/api/s/ABC123.md", "the API"],
    ["/l/trip-a1b2c3.md", "a public list"],
    ["/e/ABC123.md", "the editor"],
  ])("steps aside for %s (%s): no lookup, no header, nothing sent", async (url) => {
    const event = makeEvent(url);
    expect(await shareMarkdown(event)).toBeUndefined();
    expect(repo.getByShareCode).not.toHaveBeenCalled();
    expect(limiter.rateLimit).not.toHaveBeenCalled();
    expect(header(event, "x-robots-tag")).toBeUndefined();
    expect(event.node.res.headersSent).toBe(false);
  });

  it.each(["POST", "PUT", "DELETE"])("is a read: a %s to its address is somebody else's", async (method) => {
    const event = makeEvent("/s/ABC123.md", method);
    expect(await shareMarkdown(event)).toBeUndefined();
    expect(repo.getByShareCode).not.toHaveBeenCalled();
  });

  it("carries nothing of a route, even from a snapshot that somehow has one", async () => {
    // getByShareCode never returns these (rowToSnapshot omits them, and
    // tests/waypointPrivacy.test.ts holds it to that). This is the other end: were a
    // read path ever to leak them, the twin must not be where they become text.
    const geometry = encodePolyline([
      { lat: 45.33, lon: -121.71 },
      { lat: 45.34, lon: -121.7 },
    ]);
    const leaky: ListSnapshot = {
      ...snap(),
      routeGeometry: geometry,
      waypoints: [{ id: "w1", kind: "camp", alongM: 6_200, label: "Cairn Basin", note: "spring 40m off trail" }],
    };
    repo.getByShareCode.mockResolvedValue(leaky);
    const body = String(await shareMarkdown(makeEvent("/s/ABC123.md")));
    expect(body).not.toContain(geometry);
    expect(body).not.toContain("Cairn Basin");
    expect(body).not.toContain("spring 40m");
    expect(body).not.toContain("6200");
    // …while the list itself is all there, so this isn't passing on an empty body
    expect(body).toContain("| Zpacks Duplex | 1 | 538 g |");
  });
});
