import { defineEventHandler, getRequestURL, setHeader } from "h3";
import { setDailyEdgeCache } from "../utils/http";

// Hand-rolled robots.txt. Public, indexable surfaces (/ and the /l public lists)
// are allowed; the /e editor capability and /api are disallowed (also enforced
// per-response via X-Robots-Tag: noindex). References the sitemap on the same
// host so it works on any deploy domain.
//
// /s share links are deliberately NOT disallowed here, even though they are kept
// out of search. The two controls do different jobs. robots.txt says "don't
// fetch"; noindex says "fetch, then don't list" — and noindex only works if the
// page can be fetched, because a crawler has to read the tag to obey it. A robots
// block therefore undercut its own intent (a search engine can still index a
// blocked URL from links, without the page's noindex ever being seen), and it
// turned away the reader it was never aimed at: a user-initiated fetcher — an
// assistant someone pastes a share link into — honours robots.txt and declined the
// link before reading a byte, so "compare my list with my friend's" failed on
// every link. The /s page keeps its <meta name="robots" content="noindex">, the
// /api/s route keeps its X-Robots-Tag, and the sitemap still lists no share links.
// /e stays disallowed: its body is a client-rendered shell, so there is nothing
// for a fetcher to read, and its address is the edit capability.
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
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
});
