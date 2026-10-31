import { defineEventHandler, handleCors } from "h3";

// The connector's OAuth endpoints and discovery documents are read by browsers on
// other origins too — the MCP Inspector runs its sign-in from a page — and none of
// them reads a cookie, so they are safe to open: any origin, the three headers a
// client sends, and a 204 for the preflight. A middleware rather than a call in each
// route (there were seven, and three preflight route files), on the precedent of
// shareMarkdown.ts: one regex on the path, and everything else passes through
// untouched. /mcp itself stays closed to foreign origins (mcp.post.ts).
const OPEN = /^\/(?:token|revoke|register|\.well-known\/oauth-(?:protected-resource|authorization-server))(?:[/?]|$)/;

export default defineEventHandler((event) => {
  if (!OPEN.test(event.path)) return;
  handleCors(event, {
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "MCP-Protocol-Version"],
    maxAge: "86400",
    preflight: { statusCode: 204 },
  });
});
