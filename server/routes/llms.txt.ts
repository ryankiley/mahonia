import { defineEventHandler, getRequestURL, setHeader } from "h3";

// llms.txt — a plain-text map of the site for AI agents / LLM fetchers that would
// otherwise land on the client-rendered editor shell (/, /e) and read nothing. Points
// them at the server-rendered, human-readable surfaces. Host comes from the request so
// it works on any deploy domain (mirrors robots.txt / sitemap.xml).
export default defineEventHandler((event) => {
  const origin = getRequestURL(event).origin;
  setHeader(event, "Content-Type", "text/plain; charset=utf-8");
  setHeader(event, "Cache-Control", "public, max-age=0, s-maxage=86400");
  return [
    "# Mahonia",
    "",
    "> A no-login gear-list and pack-weight tracker for hikers. Make a packing list,",
    "> see what it weighs, and share it — no account, no app.",
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
  ].join("\n");
});
