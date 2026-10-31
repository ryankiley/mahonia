import { defineEventHandler } from "h3";
import { issueAppTokens, refreshAppTokens } from "../utils/accessTokens";
import { useAccountDb } from "../utils/db";
import { setNoStore } from "../utils/http";
import { isCodeVerifier, mcpResource, oauthError, pkceChallenge, readFormBody, redeemAuthCode } from "../utils/oauth";
import { trustedOrigin } from "../utils/origin";
import { rateLimit } from "../utils/rateLimit";

// The token endpoint (RFC 6749 §3.2, OAuth 2.1): a code becomes a token pair, and a
// refresh token becomes the next pair.
//
// Form-encoded, as the RFC says and as Claude sends it; JSON is taken too, because
// a client that gets this wrong gets a confusing 415 otherwise. No client secret is
// ever read: every client here is public, and what proves the caller started the
// sign-in is the PKCE verifier, checked against the challenge the code was minted
// with. The client_id and redirect_uri are checked against the code as well, so a
// code taken from one client's redirect can't be redeemed by another.
//
// Error codes are the RFC's own. Claude reads invalid_grant on a refresh as "this
// sign-in is over, ask the person again", and anything else as a fault to retry, so
// the two must not be confused. Answers carry no-store: a cached token response is a
// token handed to the next reader of that cache.
export default defineEventHandler(async (event) => {
  setNoStore(event);
  await rateLimit(event, "oauth-token");
  const body = await readFormBody(event);
  const db = await useAccountDb();

  if (body.grant_type === "refresh_token") {
    const next = await refreshAppTokens(db, body.refresh_token, body.client_id);
    if (!next) return oauthError(event, 400, "invalid_grant", "That refresh token is not valid for this client; sign in again.");
    return next;
  }

  if (body.grant_type !== "authorization_code") {
    return oauthError(event, 400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
  }
  if (!body.client_id) return oauthError(event, 400, "invalid_request", "client_id is required.");
  if (!isCodeVerifier(body.code_verifier)) return oauthError(event, 400, "invalid_request", "code_verifier is required: 43 to 128 unreserved characters.");
  // the resource parameter (RFC 8707) is accepted, and must name this endpoint
  if (body.resource !== undefined && body.resource !== mcpResource(trustedOrigin(event))) {
    return oauthError(event, 400, "invalid_target", `Tokens here are for ${mcpResource(trustedOrigin(event))}.`);
  }
  // the code is spent before it is checked, so a code that fails a check below is
  // gone as well: one try is all a code gets
  const code = await redeemAuthCode(db, body.code);
  if (!code) return oauthError(event, 400, "invalid_grant", "That code is unknown, used or expired.");
  if (code.clientId !== body.client_id || code.redirectUri !== body.redirect_uri) {
    return oauthError(event, 400, "invalid_grant", "That code was issued to a different client or redirect_uri.");
  }
  if (pkceChallenge(body.code_verifier) !== code.codeChallenge) {
    return oauthError(event, 400, "invalid_grant", "code_verifier does not match the code's challenge.");
  }
  return issueAppTokens(db, { userId: code.userId, clientId: code.clientId, label: code.clientName, scope: code.scope });
});
