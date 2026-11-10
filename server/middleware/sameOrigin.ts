import { defineEventHandler } from "h3";
import { refuseCrossSite } from "../utils/origin";

// EVERY WRITE TO THE API COMES FROM OUR OWN PAGE, OR FROM NO PAGE AT ALL.
//
// One rule, here, for all of /api, in place of a check each endpoint had to
// remember. It started as six: the endpoints that start or end a session, where
// the session cookie's SameSite is no defence because there is no cookie yet (a
// form on another site could post a sign-in for ITS account into a visitor's
// browser — see refuseCrossSite). Everything else leaned on SameSite alone, which
// holds in today's browsers and says nothing about the endpoint added next year
// that sets a cookie, or takes no cookie at all.
//
// What it refuses is a browser page on another site. A request with no Origin is
// not a page (the native app, curl, a server calling in) and passes untouched, so
// this is no barrier to anything that could not carry a visitor's cookies anyway.
//
// NOT here, on purpose: /mcp, /token, /register, /revoke and the discovery
// documents. Those exist to be called from other origins, authenticate by bearer
// and never read a cookie; cors.ts opens them, and mcp.post.ts has its own rule.
// Reads are left alone too: no GET changes anything.
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export default defineEventHandler((event) => {
  if (WRITES.has(event.method) && event.path.startsWith("/api/")) refuseCrossSite(event);
});
