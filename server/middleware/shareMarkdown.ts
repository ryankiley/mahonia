import { defineEventHandler, getRequestURL, setHeader } from "h3";
import { listToMarkdown } from "../../shared/exporters/markdown";
import { notFound, setNoIndex, setReadEdgeCache } from "../utils/http";
import { getByShareCode } from "../utils/listRepo";
import { rateLimit } from "../utils/rateLimit";

/**
 * /s/{code}.md: a shared list as Markdown, the twin of the /s/{code} page.
 *
 * For whoever is pasting a list into a chat, and for an agent asked to read one.
 * The page answers a fetch with HTML; this answers with the list as listToMarkdown
 * writes it (what the editor's "Copy as Markdown" puts on the clipboard), served as
 * text/markdown with the page's own cache window and rate budget. It lives outside
 * /api on purpose: robots.txt disallows /api, and a fetcher that honours robots.txt
 * would decline the twin before reading it, the exact failure this route ends.
 *
 * A MIDDLEWARE rather than a route file, and only because the router cannot say
 * this path. Nitro turns server/routes/s/[code].md.ts into `/s/:code.md`, and
 * radix3 reads a placeholder as the WHOLE segment: that route would match
 * `/s/ABC123` too, with its param named "code.md", and swallow the share page.
 * A middleware sees every request, answers the one shape it wants, and returns
 * nothing for the rest so the router (and the page behind it) still run. The cost
 * is one regex per request, on the path alone.
 *
 * Privacy is the page's. getByShareCode builds on rowToSnapshot, which never
 * carries the route's geometry or its waypoints (tests/waypointPrivacy.test.ts),
 * and listToMarkdown renders neither; tests/shareMarkdown.test.ts pins both ends.
 */
const SHARE_MARKDOWN = /^\/s\/([^/]+)\.md$/;

export default defineEventHandler(async (event) => {
  if (event.method !== "GET" && event.method !== "HEAD") return;
  const match = SHARE_MARKDOWN.exec(getRequestURL(event).pathname);
  if (!match) return;

  // the same order as /api/s: noindex before anything can throw, the budget before
  // the lookup, and the cache window only on a hit, so a 404 or a 429 is never held
  // at the edge
  setNoIndex(event);
  await rateLimit(event, "public-read");
  const snapshot = await getByShareCode(match[1]!);
  if (!snapshot) throw notFound();
  setReadEdgeCache(event);
  setHeader(event, "Content-Type", "text/markdown; charset=utf-8");
  // ends with a newline, as a file does; the clipboard copy ends on its last line
  return `${listToMarkdown(snapshot)}\n`;
});
