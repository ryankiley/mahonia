import { defineEventHandler, getRequestURL, setHeader } from "h3";
import { setDailyEdgeCache } from "../utils/http";

// llms.txt — a plain-text map of the site for AI agents / LLM fetchers that would
// otherwise land on the client-rendered editor shell (/, /e) and read nothing. Points
// them at the server-rendered, human-readable surfaces. Host comes from the request so
// it works on any deploy domain (mirrors robots.txt / sitemap.xml).
//
// A map, not a gate: nothing here grants or refuses a fetch. What a fetcher MAY read
// is robots.txt's job, which is why the share views are named here (they are readable)
// and no longer disallowed there.
export default defineEventHandler((event) => {
  const origin = getRequestURL(event).origin;
  setHeader(event, "Content-Type", "text/plain; charset=utf-8");
  setDailyEdgeCache(event);
  return [
    "# Mahonia",
    "",
    "> A gear-list and pack-weight tracker for hikers. Make a packing list,",
    "> see what it weighs, and share it. No login needed, no app.",
    "",
    "The list editor (/e) is a client-rendered app whose data lives behind an edit",
    "token in the URL fragment, so it serves no readable HTML to a fetch. Use the",
    "server-rendered pages below instead.",
    "",
    "## Pages",
    "",
    `- [About](${origin}/about): what Mahonia is and how it works`,
    `- [Public lists](${origin}/sitemap.xml): every shared public list, at /l/{slug}`,
    `- [Legal](${origin}/legal): privacy policy and terms of use`,
    "",
    "## Shared lists",
    "",
    "A share link (/s/{code}) is a read-only view of one list, rendered on the server",
    "with every row in the HTML, so it can be fetched and read as it is. It is listed",
    "nowhere and carries a noindex tag: readable by whoever holds the link, not",
    "discoverable.",
    "",
    `- ${origin}/s/{code}: the list as a page`,
    `- ${origin}/s/{code}.md: the same list as Markdown (text/markdown), one table per`,
    "  folder and a totals block, for pasting into a chat or a note",
    "",
  ].join("\n");
});
