import { defineEventHandler } from "h3";
import { setBriefEdgeCache } from "../../utils/http";
import { authorizationServerMetadata } from "../../utils/oauth";
import { trustedOrigin } from "../../utils/origin";

// RFC 8414: the authorization server's own description. Mahonia is its own issuer,
// so this sits on the same origin as /mcp and names /authorize, /token, /revoke and
// /register beside it. See authorizationServerMetadata for the two values Claude
// checks before it signs in with its metadata document.
export default defineEventHandler((event) => {
  setBriefEdgeCache(event);
  return authorizationServerMetadata(trustedOrigin(event));
});
