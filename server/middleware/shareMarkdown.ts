import { defineEventHandler, setHeader } from "h3";
import { listToMarkdown } from "../../shared/exporters/markdown";
import { notFound, setNoIndex, setReadEdgeCache } from "../utils/http";
import { getTextByShareCode } from "../utils/listRepo";
import { rateLimit } from "../utils/rateLimit";

/**
 * /s/{code}.md: a shared list as Markdown, the twin of the /s/{code} page.
 *
 * For whoever is pasting a list into a chat, and for an agent asked to read one.
 * The page answers a fetch with HTML; this answers with the list as listToMarkdown
 * writes it (what the editor's "Copy as Markdown" puts on the clipboard), served as
 * plain text with the page's own cache window and rate budget. It lives outside
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
 * Privacy is the page's. getTextByShareCode builds on rowToSnapshot, which never
 * carries the route's geometry or its waypoints (tests/waypointPrivacy.test.ts),
 * and listToMarkdown renders neither; tests/shareMarkdown.test.ts pins both ends.
 */
// The path with or without a query string. Case-insensitive on the suffix for the
// reason the code is (normalizeShareCode upper-cases): /s/abc123.MD is the same
// address, and the one half of it that refused to forgive case was this one.
const SHARE_MARKDOWN = /^\/s\/([^/?]+)\.md(?:\?|$)/i;

// Decoded like a router param would be, so a fetcher that percent-encodes the code
// reads the same list the page shows it. Malformed escapes become "", which
// normalizeShareCode turns into the 404 every other bad code gets.
function decodeCode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

export default defineEventHandler(async (event) => {
  if (event.method !== "GET" && event.method !== "HEAD") return;
  // event.path, NOT getRequestURL: that builds a URL from the Host header and throws
  // on a malformed one, and this line runs on every request the site gets, so one
  // odd Host would have 500'd every route, not just this one. The path is all there
  // is to read here.
  const match = SHARE_MARKDOWN.exec(event.path);
  if (!match) return;

  // the same order as /api/s: noindex before anything can throw, the budget before
  // the lookup, and the cache window only on a hit, so a 404 or a 429 is never held
  // at the edge
  setNoIndex(event);
  await rateLimit(event, "public-read");
  const snapshot = await getTextByShareCode(decodeCode(match[1]!));
  if (!snapshot) throw notFound();
  setReadEdgeCache(event);
  // text/plain, not text/markdown. The body IS Markdown and the address says so, but
  // Firefox has no inline viewer for text/markdown and offers a download instead
  // (Chrome and Safari show it as text), and with nosniff on every route it can't
  // guess its way back to text. Plain text displays everywhere, and a fetcher reads
  // the body the same either way — GitHub's raw view makes the same call for .md.
  setHeader(event, "Content-Type", "text/plain; charset=utf-8");
  // ends with a newline, as a file does; the clipboard copy ends on its last line
  return `${listToMarkdown(snapshot)}\n`;
});
