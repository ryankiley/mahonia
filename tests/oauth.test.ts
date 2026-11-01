import { eq } from "drizzle-orm";
import type { EventHandler } from "h3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import tokensGet from "../server/api/account/tokens.get";
import tokensRevoke from "../server/api/account/tokens/revoke.post";
import authorizeGet from "../server/api/oauth/authorize.get";
import authorizePost from "../server/api/oauth/authorize.post";
import asMetadata from "../server/routes/.well-known/oauth-authorization-server.get";
import prmRoot from "../server/routes/.well-known/oauth-protected-resource/index.get";
import prmMcp from "../server/routes/.well-known/oauth-protected-resource/mcp.get";
import mcp from "../server/routes/mcp.post";
import register from "../server/routes/register.post";
import revoke from "../server/routes/revoke.post";
import token from "../server/routes/token.post";
import { APP_ACCESS_PREFIX, APP_ACCESS_TTL_S, APP_REFRESH_PREFIX, listAccessTokens, revokeAllAccessTokens } from "../server/utils/accessTokens";
import { deleteAccount } from "../server/utils/accountRepo";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { sweepExpiredAuth } from "../server/utils/authSession";
import { LISTS_DDL } from "../server/utils/db";
import { pkceChallenge, redirectWith } from "../server/utils/oauth";
import { REGISTERED_CLIENT_PREFIX, _forgetClientDocuments, redirectUriAllowed } from "../server/utils/oauthClients";
import { randomSecret, sha256Hex } from "../server/utils/tokens";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { createTestDb, type TestDb } from "./helpers/db";
import { dbState } from "./helpers/dbMock";
import { jsonResponse, makeEvent, stubFetch } from "./helpers/http";
import { signInCookie } from "./helpers/session";

// Signing in to the connector, end to end against a real (in-memory) database and the
// real route handlers, the way Claude's client walks it: a gear call is refused with
// a 401 that names the discovery document; the documents say where to sign in; the
// client identifies itself by the URL of its own metadata; the person allows; the
// code is traded for a token pair with PKCE; the token opens the gear tools; the
// refresh rotates; a revocation ends it. Each step's rules are pinned where a wrong
// answer would let a stranger in.

vi.mock("../server/utils/db", async (o) => (await import("./helpers/dbMock")).mockDbModule(o));
vi.mock("../server/utils/rateLimit", () => ({
  rateLimit: async () => {},
  rateLimitSubject: async () => {},
  useKv: () => ({ getItem: async () => null, setItem: async () => {} }),
}));
// the metadata document's host resolves to a public address; the private one is the
// SSRF case
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => [{ address: host === "internal.test" ? "10.0.0.5" : "151.101.1.140", family: 4 }],
}));

const ORIGIN = "http://mahonia.test";
const CLAUDE = "https://claude.test/oauth/client.json";
const CALLBACK = "https://claude.test/api/mcp/auth_callback";
const CODE_CLIENT = "https://code.claude.test/client-metadata.json";

/** the metadata documents the stubbed network serves */
const documents: Record<string, unknown> = {
  [CLAUDE]: { client_id: CLAUDE, client_name: "Claude", redirect_uris: [CALLBACK] },
  [CODE_CLIENT]: { client_id: CODE_CLIENT, client_name: "Claude Code", redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"] },
  "https://liar.test/client.json": { client_id: "https://someone-else.test/client.json", redirect_uris: [CALLBACK] },
};

/** drive one handler: method, path, headers, a body as a form or as JSON, a cookie */
async function hit(
  handler: EventHandler,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; form?: Record<string, string>; json?: unknown; cookie?: string } = {},
) {
  const event = makeEvent(path, {
    method: opts.method ?? (opts.form || opts.json ? "POST" : "GET"),
    headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    ...(opts.form ? { body: new URLSearchParams(opts.form).toString(), contentType: "application/x-www-form-urlencoded" } : {}),
    ...(opts.json !== undefined ? { body: opts.json } : {}),
  });
  let body: unknown;
  let thrown: { statusCode?: number } | undefined;
  try {
    body = await handler(event);
  } catch (e) {
    thrown = e as { statusCode?: number };
  }
  return {
    status: thrown?.statusCode ?? event.node.res.statusCode,
    body: body as Record<string, unknown>,
    header: (name: string) => String(event.node.res.getHeader(name) ?? ""),
  };
}

const rpc = (name: string, args: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const gear = (bearer?: string, name = "get_my_gear", args: unknown = {}) =>
  hit(mcp, "/mcp", { json: rpc(name, args), headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

/** the request Claude's client builds, with a fresh PKCE pair */
function request(over: Record<string, string> = {}) {
  const verifier = randomSecret() + randomSecret();
  return {
    verifier,
    query: {
      response_type: "code",
      client_id: CLAUDE,
      redirect_uri: CALLBACK,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      scope: "read offline_access",
      state: "st-" + randomSecret().slice(0, 8),
      resource: `${ORIGIN}/mcp`,
      ...over,
    },
  };
}
const qs = (q: Record<string, string>) => new URLSearchParams(q).toString();

/** Allow at the consent page, as the signed-in person: the code out of the redirect */
async function allow(cookie: string, query: Record<string, string>) {
  const r = await hit(authorizePost, "/api/oauth/authorize", { json: { ...query, decision: "allow" }, cookie, headers: { origin: ORIGIN } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const back = new URL(r.body.redirect as string);
  return { code: back.searchParams.get("code")!, state: back.searchParams.get("state"), back };
}

/** trade a code at the token endpoint */
const exchange = (code: string, verifier: string, over: Record<string, string> = {}) =>
  hit(token, "/token", { form: { grant_type: "authorization_code", code, code_verifier: verifier, client_id: CLAUDE, redirect_uri: CALLBACK, resource: `${ORIGIN}/mcp`, ...over } });
const refreshWith = (refresh: string, client_id = CLAUDE) => hit(token, "/token", { form: { grant_type: "refresh_token", refresh_token: refresh, client_id } });

/** a signed-in app, start to finish: the sign-in allowed and the code traded */
async function connect(cookie: string, scope: string) {
  const { query, verifier } = request({ scope });
  const r = await exchange((await allow(cookie, query)).code, verifier);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { access: r.body.access_token as string, refresh: r.body.refresh_token as string };
}

const apps = async (userId: number) => (await listAccessTokens(db, userId)).filter((t) => t.kind === "app");

let db: TestDb;
let me = 0;
let other = 0;
let cookie = "";

beforeAll(async () => {
  db = await createTestDb(LISTS_DDL, ACCOUNT_DDL, VAULT_DDL);
  dbState.db = db;
  [me, other] = (await db.insert(schema.users).values([{ email: "me@example.com" }, { email: "other@example.com" }]).returning()).map((u) => u.id);
  cookie = (await signInCookie(db, me)).cookie;
});
beforeEach(() => {
  _forgetClientDocuments();
  stubFetch((url) => (url in documents ? jsonResponse(documents[url]) : { ok: false, status: 404, headers: new Headers() }));
});

describe("discovery", () => {
  it("names the endpoint, the issuer and the scopes, at the path clients try first and at the root", async () => {
    for (const handler of [prmMcp, prmRoot]) {
      const r = await hit(handler, "/.well-known/oauth-protected-resource/mcp");
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], scopes_supported: ["read", "write"], bearer_methods_supported: ["header"] });
    }
  });

  it("describes the authorization server with the two values Claude needs before it uses its metadata document", async () => {
    const r = await hit(asMetadata, "/.well-known/oauth-authorization-server");
    expect(r.body).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      revocation_endpoint: `${ORIGIN}/revoke`,
      registration_endpoint: `${ORIGIN}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
    });
    expect(r.body.scopes_supported).toContain("offline_access");
  });
});

describe("the door", () => {
  it("refuses a gear call with no bearer with a 401 that names the document and the scope", async () => {
    const r = await gear();
    expect(r.status).toBe(401);
    expect(r.header("www-authenticate")).toBe(
      `Bearer error="invalid_token", error_description="Sign in to Mahonia to reach your lists and My Gear.", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="read"`,
    );
    expect(r.body).toEqual({ error: "invalid_token", error_description: "Sign in to Mahonia to reach your lists and My Gear." });
    expect((await gear(undefined, "update_my_gear", { id: 1 })).header("www-authenticate")).toContain('scope="write"');
  });

  it("leaves the list tools and the handshake open", async () => {
    expect((await hit(mcp, "/mcp", { json: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } })).status).toBe(200);
    expect((await hit(mcp, "/mcp", { json: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } })).status).toBe(200);
    const r = await gear(undefined, "get_list", { share_code: "nope" });
    expect(r.status).toBe(200);
    expect(r.header("www-authenticate")).toBe("");
  });
});

describe("the authorization request", () => {
  it("reads the client's metadata document and names the client by its host", async () => {
    const { query } = request();
    const r = await hit(authorizeGet, `/api/oauth/authorize?${qs(query)}`);
    expect(r.body).toEqual({ ok: true, client: { label: "claude.test", kind: "document" }, level: "read", returnTo: { host: "claude.test", loopback: false } });
    expect((await hit(authorizeGet, `/api/oauth/authorize?${qs(request({ scope: "write" }).query)}`)).body).toMatchObject({ level: "write" });
  });

  it("refuses a document that doesn't name itself, one it can't reach, and one on a private host", async () => {
    for (const client_id of ["https://liar.test/client.json", "https://nowhere.test/client.json", "https://internal.test/client.json", "https://claude.test/", "http://claude.test/client.json", "not a url"]) {
      const r = await hit(authorizeGet, `/api/oauth/authorize?${qs(request({ client_id }).query)}`);
      expect(r.body, client_id).toMatchObject({ ok: false, error: "invalid_client", redirect: null });
    }
  });

  it("sends nothing to a redirect the client didn't register", async () => {
    for (const redirect_uri of ["https://evil.test/cb", "https://claude.test/api/mcp/auth_callback?x=1", "http://claude.test/api/mcp/auth_callback"]) {
      const r = await hit(authorizeGet, `/api/oauth/authorize?${qs(request({ redirect_uri }).query)}`);
      expect(r.body, redirect_uri).toMatchObject({ ok: false, error: "invalid_request", redirect: null });
    }
  });

  it("matches a loopback redirect without its port, and only there", () => {
    const registered = ["http://localhost/callback", "http://127.0.0.1/callback", CALLBACK];
    expect(redirectUriAllowed("http://localhost:3118/callback", registered)).toBe(true);
    expect(redirectUriAllowed("http://127.0.0.1:51234/callback", registered)).toBe(true);
    expect(redirectUriAllowed("http://localhost:3118/other", registered)).toBe(false);
    expect(redirectUriAllowed("http://localhost.evil.test:3118/callback", registered)).toBe(false);
    expect(redirectUriAllowed("https://claude.test:8443/api/mcp/auth_callback", registered)).toBe(false);
    expect(redirectUriAllowed(CALLBACK, registered)).toBe(true);
    expect(redirectUriAllowed("http://claude.test/api/mcp/auth_callback", ["http://claude.test/api/mcp/auth_callback"])).toBe(false);
  });

  it("tells a loopback client's person where they are being sent, with the warning", async () => {
    const { query } = request({ client_id: CODE_CLIENT, redirect_uri: "http://localhost:3118/callback" });
    const r = await hit(authorizeGet, `/api/oauth/authorize?${qs(query)}`);
    expect(r.body).toMatchObject({ ok: true, client: { label: "code.claude.test" }, returnTo: { host: "localhost:3118", loopback: true } });
  });

  it("sends the rest of the mistakes back to the client as errors, with its state, and only bounces on its own to the client's own host", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ code_challenge: "" }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ scope: "read admin" }, "invalid_scope"],
      [{ resource: "https://elsewhere.test/mcp" }, "invalid_target"],
    ];
    for (const [over, error] of cases) {
      const { query } = request(over);
      const r = await hit(authorizeGet, `/api/oauth/authorize?${qs(query)}`);
      expect(r.body.ok, error).toBe(false);
      expect(r.body.error).toBe(error);
      // Claude's document and its callback share a host, so the page may follow
      expect(r.body.auto).toBe(true);
      const back = new URL(r.body.redirect as string);
      expect(back.origin + back.pathname).toBe(CALLBACK);
      expect(back.searchParams.get("error")).toBe(error);
      expect(back.searchParams.get("state")).toBe(query.state);
    }
    // a loopback redirect is not the document's host: the person gets a link, not a bounce
    const code = await hit(authorizeGet, `/api/oauth/authorize?${qs(request({ client_id: CODE_CLIENT, redirect_uri: "http://localhost:3118/callback", response_type: "token" }).query)}`);
    expect(code.body).toMatchObject({ ok: false, auto: false });
    expect(code.body.redirect).toContain("http://localhost:3118/callback?error=");
  });
});

describe("consent", () => {
  it("needs a signed-in person, and the page's own origin", async () => {
    const { query } = request();
    expect((await hit(authorizePost, "/api/oauth/authorize", { json: { ...query, decision: "allow" }, headers: { origin: ORIGIN } })).status).toBe(401);
    expect((await hit(authorizePost, "/api/oauth/authorize", { json: { ...query, decision: "allow" }, cookie, headers: { origin: "https://evil.test" } })).status).toBe(403);
    expect((await hit(authorizePost, "/api/oauth/authorize", { json: { ...query, decision: "allow" }, cookie })).status).toBe(403);
  });

  it("sends Deny back as access_denied with the state, and mints nothing", async () => {
    const { query } = request();
    const r = await hit(authorizePost, "/api/oauth/authorize", { json: { ...query, decision: "deny" }, cookie, headers: { origin: ORIGIN } });
    const back = new URL(r.body.redirect as string);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe(query.state);
    expect(back.searchParams.get("code")).toBeNull();
    expect(await db.select().from(schema.oauthCodes)).toHaveLength(0);
  });

  it("sends Allow back as a code bound to the request, with the state", async () => {
    const { query } = request({ client_id: CODE_CLIENT, redirect_uri: "http://localhost:3118/callback" });
    const { code, state, back } = await allow(cookie, query);
    expect(state).toBe(query.state);
    expect(back.origin + back.pathname).toBe("http://localhost:3118/callback");
    expect(code).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const [row] = await db.select().from(schema.oauthCodes).where(eq(schema.oauthCodes.codeHash, sha256Hex(code)));
    expect(row).toMatchObject({ userId: me, clientId: CODE_CLIENT, clientName: "code.claude.test", redirectUri: "http://localhost:3118/callback", codeChallenge: query.code_challenge, scope: "read" });
    expect(row!.consumedAt).toBeNull();
    // a registered redirect that carries a query keeps it beside the code
    expect(redirectWith("https://app.test/cb?from=mahonia", { code: "c", state: null })).toBe("https://app.test/cb?from=mahonia&code=c");
  });
});

describe("the token endpoint", () => {
  it("trades a code and its verifier for a token pair, once", async () => {
    const { query, verifier } = request({ scope: "write offline_access" });
    const { code } = await allow(cookie, query);
    const r = await exchange(code, verifier);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.header("cache-control")).toBe("no-store");
    expect(r.body).toMatchObject({ token_type: "Bearer", expires_in: APP_ACCESS_TTL_S, scope: "write" });
    expect(r.body.access_token).toMatch(new RegExp(`^${APP_ACCESS_PREFIX}`));
    expect(r.body.refresh_token).toMatch(new RegExp(`^${APP_REFRESH_PREFIX}`));
    // neither value is in the database; the row is an app's, labelled by its host
    const [row] = await db.select().from(schema.accessTokens);
    expect(row).toMatchObject({ kind: "app", label: "claude.test", clientId: CLAUDE, scope: "write", tokenHash: sha256Hex(r.body.access_token as string), refreshHash: sha256Hex(r.body.refresh_token as string) });
    expect(row!.expiresAt).not.toBeNull();
    // the code is spent: a second exchange, verifier and all, is refused
    const again = await exchange(code, verifier);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
    await revokeAllAccessTokens(db, me);
  });

  it("refuses a wrong verifier, and spends the code doing so", async () => {
    const { query, verifier } = request();
    const { code } = await allow(cookie, query);
    const wrong = await exchange(code, verifier.slice(1) + "x");
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("invalid_grant");
    expect((await exchange(code, verifier)).body.error).toBe("invalid_grant");
  });

  it("refuses a code presented by another client, another redirect, or after it expired", async () => {
    const one = request();
    const { code: c1 } = await allow(cookie, one.query);
    expect((await exchange(c1, one.verifier, { client_id: CODE_CLIENT })).body.error).toBe("invalid_grant");
    const two = request();
    const { code: c2 } = await allow(cookie, two.query);
    expect((await exchange(c2, two.verifier, { redirect_uri: "https://claude.test/api/mcp/other" })).body.error).toBe("invalid_grant");
    const three = request();
    const { code: c3 } = await allow(cookie, three.query);
    await db.update(schema.oauthCodes).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(schema.oauthCodes.codeHash, sha256Hex(c3)));
    expect((await exchange(c3, three.verifier)).body.error).toBe("invalid_grant");
    // the sweep that rides with the auth sweep clears it
    await sweepExpiredAuth(db);
    expect(await db.select().from(schema.oauthCodes).where(eq(schema.oauthCodes.codeHash, sha256Hex(c3)))).toHaveLength(0);
  });

  it("answers malformed requests with the RFC's own errors", async () => {
    expect((await hit(token, "/token", { form: { grant_type: "password" } })).body.error).toBe("unsupported_grant_type");
    expect((await hit(token, "/token", { form: { grant_type: "authorization_code", code: "x", client_id: CLAUDE, redirect_uri: CALLBACK } })).body.error).toBe("invalid_request");
    expect((await hit(token, "/token", { form: { grant_type: "authorization_code", code: "x", code_verifier: "a".repeat(43), redirect_uri: CALLBACK } })).body.error).toBe("invalid_request");
    const r = await hit(token, "/token", { form: { grant_type: "authorization_code", code: "x", code_verifier: "a".repeat(43), client_id: CLAUDE, redirect_uri: CALLBACK, resource: "https://elsewhere.test/mcp" } });
    expect(r.body.error).toBe("invalid_target");
    expect((await refreshWith(`${APP_REFRESH_PREFIX}nope`)).body.error).toBe("invalid_grant");
  });
});

describe("a signed-in app at the gear tools", () => {
  let access = "";
  let refresh = "";
  let readAccess = "";

  it("opens the gear with its access token, at the scope it was allowed", async () => {
    ({ access, refresh } = await connect(cookie, "write offline_access"));
    const add = await gear(access, "add_my_gear", { items: [{ name: "Windburner", brand: "MSR" }] });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    const list = await gear(access);
    expect(list.status).toBe(200);
    expect(((list.body.result as { structuredContent: { gear: { name: string }[] } }).structuredContent.gear).map((g) => g.name)).toEqual(["Windburner"]);

    readAccess = (await connect(cookie, "read")).access;
    expect((await gear(readAccess)).status).toBe(200);
    const stepUp = await gear(readAccess, "add_my_gear", { items: [{ name: "x" }] });
    expect(stepUp.status).toBe(403);
    expect(stepUp.header("www-authenticate")).toContain('error="insufficient_scope"');
    expect(stepUp.header("www-authenticate")).toContain('scope="write"');
  });

  it("is listed on the account page by the client's host, and files a list it makes", async () => {
    const listed = await apps(me);
    expect(listed.map((a) => [a.label, a.scope])).toEqual([["claude.test", "read"], ["claude.test", "write"]]);
    expect(listed.every((a) => a.lastUsedAt)).toBe(true);
    const page = await hit(tokensGet, "/api/account/tokens", { cookie });
    expect((page.body.tokens as { kind: string }[]).map((t) => t.kind)).toEqual(["app", "app"]);
    const made = await gear(access, "create_list", { title: "Loop", items: [{ name: "Spork", weight_g: 10 }] });
    expect((made.body.result as { structuredContent: { saved_to_account: boolean } }).structuredContent.saved_to_account).toBe(true);
    const list = await gear(access);
    expect(((list.body.result as { structuredContent: { gear: { name: string }[] } }).structuredContent.gear).map((g) => g.name)).toEqual(["Spork", "Windburner"]);
  });

  it("rotates on refresh: the old pair dies, the new one works, and no other client can refresh it", async () => {
    const r = await refreshWith(refresh);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.scope).toBe("write");
    const next = r.body.access_token as string;
    expect(next).not.toBe(access);
    expect((await gear(access)).status).toBe(401);
    expect((await gear(next)).status).toBe(200);
    expect((await refreshWith(r.body.refresh_token as string, CODE_CLIENT)).body.error).toBe("invalid_grant");
    access = next;
    refresh = r.body.refresh_token as string;
  });

  it("is refused once its access token has aged out, so the client refreshes", async () => {
    await db.update(schema.accessTokens).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(schema.accessTokens.tokenHash, sha256Hex(access)));
    const r = await gear(access);
    expect(r.status).toBe(401);
    expect(r.header("www-authenticate")).toContain('error="invalid_token"');
    const again = await refreshWith(refresh);
    expect(again.status).toBe(200);
    access = again.body.access_token as string;
    refresh = again.body.refresh_token as string;
    expect((await gear(access)).status).toBe(200);
  });

  it("ends the grant when a refresh token that was rotated away comes back", async () => {
    const rotated = await refreshWith(refresh);
    expect(rotated.status).toBe(200);
    // the token the rotation retired: two parties hold it, and the second to present
    // it is not the client
    expect((await refreshWith(refresh)).body.error).toBe("invalid_grant");
    expect((await gear(rotated.body.access_token as string)).status).toBe(401);
    expect((await refreshWith(rotated.body.refresh_token as string)).body.error).toBe("invalid_grant");
    expect((await apps(me)).map((a) => a.scope)).toEqual(["read"]);
  });

  it("ends at the revocation endpoint, from the account page, or with the account", async () => {
    ({ access, refresh } = await connect(cookie, "write"));
    expect((await hit(revoke, "/revoke", { form: { token: refresh } })).status).toBe(200);
    expect((await gear(access)).status).toBe(401);
    expect((await hit(revoke, "/revoke", { form: { token: `${APP_ACCESS_PREFIX}never` } })).status).toBe(200);

    const [app] = await apps(me);
    expect(app!.scope).toBe("read");
    expect((await hit(tokensRevoke, "/api/account/tokens/revoke", { json: { id: app!.id }, cookie: (await signInCookie(db, other)).cookie })).body).toEqual({ ok: false });
    expect((await hit(tokensRevoke, "/api/account/tokens/revoke", { json: { id: app!.id }, cookie })).body).toEqual({ ok: true });
    expect((await gear(readAccess)).status).toBe(401);

    await connect(cookie, "read");
    expect(await apps(me)).toHaveLength(1);
    await deleteAccount(db, me, { deleteLists: false });
    expect(await db.select().from(schema.accessTokens)).toHaveLength(0);
    expect(await db.select().from(schema.oauthCodes)).toHaveLength(0);
  });
});

describe("a client that registers itself", () => {
  it("gets a public client id, and signs in through it like any other", async () => {
    const r = await hit(register, "/register", { json: { client_name: "Cursor", redirect_uris: ["https://cursor.test/oauth/callback"], token_endpoint_auth_method: "none" } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ client_name: "Cursor", redirect_uris: ["https://cursor.test/oauth/callback"], token_endpoint_auth_method: "none" });
    const clientId = r.body.client_id as string;
    expect(clientId.startsWith(REGISTERED_CLIENT_PREFIX)).toBe(true);
    expect(r.body).not.toHaveProperty("client_secret");

    const who = (await signInCookie(db, other)).cookie;
    const { query, verifier } = request({ client_id: clientId, redirect_uri: "https://cursor.test/oauth/callback" });
    expect((await hit(authorizeGet, `/api/oauth/authorize?${qs(query)}`)).body).toMatchObject({ ok: true, client: { label: "Cursor", kind: "registered" } });
    const { code } = await allow(who, query);
    const tokens = await exchange(code, verifier, { client_id: clientId, redirect_uri: "https://cursor.test/oauth/callback" });
    expect(tokens.status).toBe(200);
    expect((await gear(tokens.body.access_token as string)).status).toBe(200);
    expect((await apps(other)).map((a) => a.label)).toEqual(["Cursor"]);
  });

  it("refuses a registration it can't honour", async () => {
    expect((await hit(register, "/register", { json: { redirect_uris: [] } })).body.error).toBe("invalid_redirect_uri");
    expect((await hit(register, "/register", { json: { redirect_uris: ["http://cursor.test/cb"] } })).body.error).toBe("invalid_redirect_uri");
    expect((await hit(register, "/register", { json: { redirect_uris: ["https://cursor.test/cb"], token_endpoint_auth_method: "client_secret_basic" } })).body.error).toBe("invalid_client_metadata");
    expect((await hit(authorizeGet, `/api/oauth/authorize?${qs(request({ client_id: `${REGISTERED_CLIENT_PREFIX}unknown` }).query)}`)).body).toMatchObject({ ok: false, error: "invalid_client" });
  });
});
