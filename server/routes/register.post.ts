import { defineEventHandler, setResponseStatus } from "h3";
import { useAccountDb } from "../utils/db";
import { readJsonBodyCapped, setNoStore } from "../utils/http";
import { oauthError } from "../utils/oauth";
import { cleanClientName, cleanRedirectUris, registerOAuthClient } from "../utils/oauthClients";
import { rateLimit } from "../utils/rateLimit";

// Dynamic client registration (RFC 7591), for the clients that don't carry a
// metadata document: a name and the redirect URIs it may be sent to, and a client_id
// back. Public clients only — a secret would be issued to whoever asked for one, so
// none is, and token_endpoint_auth_method is "none" whatever was requested.
//
// Anyone may call this, and every call writes a row, so it has the sign-in budget
// (rateLimit "oauth-register"). Claude never calls it once the server metadata
// advertises metadata documents, which is why the table stays small.
export default defineEventHandler(async (event) => {
  setNoStore(event);
  await rateLimit(event, "oauth-register");
  const body = await readJsonBodyCapped<Record<string, unknown>>(event, 8_192);
  const redirectUris = cleanRedirectUris(body?.redirect_uris);
  if (!redirectUris) return oauthError(event, 400, "invalid_redirect_uri", "redirect_uris must list one to twenty https or loopback URIs.");
  const method = body?.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") return oauthError(event, 400, "invalid_client_metadata", "Only public clients register here: token_endpoint_auth_method must be none.");
  const made = await registerOAuthClient(await useAccountDb(), { clientName: cleanClientName(body?.client_name), redirectUris });
  setResponseStatus(event, 201);
  return {
    client_id: made.clientId,
    client_id_issued_at: Math.floor(made.createdAt.getTime() / 1000),
    client_name: cleanClientName(body?.client_name) ?? undefined,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
});
