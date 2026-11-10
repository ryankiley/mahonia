import { defineEventHandler, getQuery } from "h3";
import { useAccountDb } from "../../utils/db";
import { setNoIndex, setPrivate } from "../../utils/http";
import { checkAuthorizeRequest } from "../../utils/oauth";
import { isLoopbackHost } from "../../utils/oauthClients";
import { trustedOrigin } from "../../utils/origin";
import { rateLimit } from "../../utils/rateLimit";

// What the /authorize page needs to render: the request checked, the client named,
// and the scope. No session is needed to ask — the page shows the sign-in first when
// there is none — and nothing here mints anything; Allow is the POST.
//
// A failed check that the client should hear about comes back with its error
// redirect, for the page to offer as a link and never to follow on its own. Anyone
// may register a client with any redirect, or host a metadata document beside one on
// their own site, so no request proves its redirect is safe to bounce to unasked: a
// page that did would be an open redirector on this origin (RFC 9700 §4.11.2).
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  setPrivate(event);
  await rateLimit(event, "oauth-authorize");
  const check = await checkAuthorizeRequest(await useAccountDb(), trustedOrigin(event), getQuery(event));
  if (!check.ok) return { ok: false as const, error: check.error, description: check.description, redirect: check.redirect };
  const back = new URL(check.redirectUri);
  return {
    ok: true as const,
    client: { label: check.client.label, kind: check.client.kind },
    level: check.scope,
    // what the person is told about where they will be sent, hostname only; a
    // loopback address gets the spec's warning, since any program on the machine
    // could be listening there
    returnTo: { host: back.host, loopback: back.protocol === "http:" && isLoopbackHost(back.hostname) },
  };
});
