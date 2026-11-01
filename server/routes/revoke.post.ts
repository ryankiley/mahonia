import { defineEventHandler } from "h3";
import { revokeByToken } from "../utils/accessTokens";
import { useAccountDb } from "../utils/db";
import { setNoStore } from "../utils/http";
import { readFormBody } from "../utils/oauth";
import { rateLimit } from "../utils/rateLimit";

// Token revocation (RFC 7009): a client disconnecting ends its grant here, whichever
// of the pair it sends. The answer is 200 whether or not anything matched — the RFC
// asks for that, and it keeps this from being a way to ask whether a token exists.
export default defineEventHandler(async (event) => {
  setNoStore(event);
  await rateLimit(event, "oauth-revoke");
  const body = await readFormBody(event);
  await revokeByToken(await useAccountDb(), body.token);
  return {};
});
