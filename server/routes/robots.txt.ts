import { defineEventHandler, getRequestURL, setHeader } from "h3";
import { setDailyEdgeCache } from "../utils/http";

// Hand-rolled robots.txt. The /e editor capability, /mine and /api are disallowed;
// everything else, the /s share views included, may be fetched. References the
// sitemap on the same host so it works on any deploy domain.
//
// /s/ was disallowed here once, and that was the wrong tool for what it meant. A
// share link is kept out of search by the page's own <meta name="robots"
// content="noindex"> (and by X-Robots-Tag on /api/s and /s/{code}.md), and a robots
// block HIDES that tag: a crawler that may not fetch the page never reads the
// noindex, so it can still index the bare URL off a link somewhere else. Letting
// it fetch, read the tag and leave is how noindex is meant to work. The block also
// turned away every well-behaved user-initiated fetcher (an assistant handed a
// share link and asked to read the list) before it read a byte, which is the
// failure people actually noticed. The sitemap never lists a share link, so
// nothing advertises one either way. tests/crawlerText.test.ts holds the pair
// together: this file may only leave /s open while the page keeps its tag.
export default defineEventHandler((event) => {
  const origin = getRequestURL(event).origin;
  setHeader(event, "Content-Type", "text/plain; charset=utf-8");
  setDailyEdgeCache(event);
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /e",
    // /mine is a 301 to /e now (the page retired into the editor's switcher). The
    // rule stays: it stops a crawler walking the redirect rather than leaving it to
    // be turned away at the other end.
    "Disallow: /mine",
    "Disallow: /api/",
    // /mcp is NOT disallowed, for the reason /s/ isn't. Every answer it gives carries
    // X-Robots-Tag: noindex, so a crawler that fetches it reads the tag and leaves; a
    // block here would only turn away the user-initiated fetchers, which then tell
    // the person "this site blocks automated fetching" instead of reading the 405
    // whose body says what the address is for. That happened, the first day.
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
});
