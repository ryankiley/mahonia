import { createError, defineEventHandler, getHeader } from "h3";
import { requireAccount } from "../../utils/authSession";
import { readJsonBodyCapped } from "../../utils/http";
import { checkAuthorizeRequest, errorRedirect, mintAuthCode, redirectWith } from "../../utils/oauth";
import { trustedOrigin } from "../../utils/origin";

// The consent page's Allow or Deny. Needs the session (the person is the account
// the grant is for) and the page's own origin on the request (a form on some other
// site can't press Allow with a Mahonia cookie). The request's parameters are
// checked again here, not trusted from the page: the page only ever repeats what
// the client put in the URL, and the client is the party being judged.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "oauth-authorize");
  const origin = trustedOrigin(event);
  if (getHeader(event, "origin") !== origin) throw createError({ statusCode: 403, statusMessage: "Origin not allowed" });
  const body = await readJsonBodyCapped<Record<string, unknown>>(event, 8_192);
  const check = await checkAuthorizeRequest(db, origin, body ?? {});
  if (!check.ok) return { ok: false as const, error: check.error, description: check.description, redirect: check.redirect };
  if (body.decision !== "allow") {
    return { ok: true as const, redirect: errorRedirect(check.redirectUri, "access_denied", "The person declined.", check.state) };
  }
  const code = await mintAuthCode(db, {
    userId: user.id,
    client: check.client,
    redirectUri: check.redirectUri,
    codeChallenge: check.codeChallenge,
    scope: check.scope,
  });
  return { ok: true as const, redirect: redirectWith(check.redirectUri, { code, state: check.state }) };
});
