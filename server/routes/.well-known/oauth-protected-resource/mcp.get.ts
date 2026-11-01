import { defineEventHandler } from "h3";
import { setBriefEdgeCache } from "../../../utils/http";
import { protectedResourceMetadata } from "../../../utils/oauth";
import { trustedOrigin } from "../../../utils/origin";

// RFC 9728 for the endpoint at /mcp: "tokens for this resource come from this
// issuer, and these are the scopes". The address the MCP route's 401 points at, so
// a client that has never heard of Mahonia learns where to send someone to sign in.
// The root document (index.get.ts) is this one again, for a client that probes.
export default defineEventHandler((event) => {
  setBriefEdgeCache(event);
  return protectedResourceMetadata(trustedOrigin(event));
});
