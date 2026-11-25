import { defineEventHandler, getHeader, readRawBody, send, setHeader, setResponseStatus, type H3Event } from "h3";
import { BUDGET_WAIT, MCP_INSTRUCTIONS, MCP_LATEST_VERSION, MCP_PROTOCOL_VERSIONS, MCP_SERVER_INFO, accountUse, callTool, isAdminTool, isKnownTool, mcpToolsFor, toolFailure } from "../utils/mcp";
import { setNoIndex, setNoStore } from "../utils/http";
import { APP_ACCESS_PREFIX, connectorToken, resolveBearer } from "../utils/accessTokens";
import { anyAdmin, isAdmin } from "../utils/admin";
import { useAccountDb } from "../utils/db";
import { bearerChallenge } from "../utils/oauth";
import { trustedOrigin } from "../utils/origin";
import { rateLimit } from "../utils/rateLimit";

// The MCP endpoint: Mahonia as a connector, served by the app itself.
//
// One URL, /mcp, speaking JSON-RPC 2.0 over the Streamable HTTP transport, STATELESS:
// every POST is answered with one JSON object, no session id is ever issued or
// required, and the GET that a streaming server would answer with events gets a 405
// here (mcp.get.ts), which the transport allows. Hand-rolled rather than the SDK: the
// five methods a tools-only server answers fit on one screen, the SDK brings sessions
// and streams this deployment has no use for, and a dependency in the request path
// of a public endpoint is exactly the kind of surface the rest of this server avoids.
//
// Protocol errors (a body that isn't JSON-RPC, a method or tool that doesn't exist)
// are JSON-RPC errors; what goes wrong INSIDE a tool comes back as a result with
// isError, so the model can read it and correct itself. A revision this server does
// not speak gets a 400 with a plain JSON-RPC error and none of the newer spec's
// reserved codes, which is the answer a newer client falls back from cleanly.
//
// No authentication at the door for the list tools, on purpose: a share code is
// already the read capability and an edit link the write one, and both travel as
// tool arguments (server/utils/mcp.ts). initialize, tools/list and every list tool
// answer 200 to a request with no credential at all, so a connector added with no
// sign-in works as it always has.
//
// The account tools are the exception, and the ONE place this endpoint answers 401 or
// 403: get_my_gear and edit_my_gear; a get_list with no share_code, which is asking
// for the lists filed under an account; and an edit_list that names its list by
// share_code rather than by edit link, which is asking to change one of them. The last
// two are account tools for that call and list tools otherwise. A 401 is the signal Claude's clients
// read as "this server wants a sign-in": on it, and only on it, Claude shows the
// Connect card, runs the OAuth sign-in (server/utils/oauth.ts) and retries the call. So
// a tools/call naming an account tool with no valid bearer — none, unknown, revoked, or
// an access token past its hour — gets a 401 whose WWW-Authenticate header names our
// protected-resource document and asks for read-and-change, whichever account tool it
// was. Claude asks for exactly the scope a 401 names, and its apps don't run the
// step-up the spec describes for a 403: a read-only bearer on a tool that changes gear
// or a list gets a 403 with insufficient_scope, and Claude shows that as "reconnect it
// from connector settings" and stops (seen 2026-11-09). A sign-in that began at a read
// tool and asked only for read was a dead end the first time the person wanted a
// change, so every sign-in asks for both; Claude still asks the person before it calls
// a tool that changes something. The 403 stays for what is read-only on purpose: a
// token minted read-only on the account page, or a sign-in made before this. The
// gate runs here, on the parsed body, before any tool: a refusal wrapped in a 200 tool
// result is a sentence the model reads aloud, not a sign-in.

/** a JSON-RPC body is small; a list's rows arrive a few hundred at most */
const MAX_BODY_BYTES = 262_144;
type Id = string | number;

const error = (id: Id | null, code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });
const result = (id: Id, value: unknown) => ({ jsonrpc: "2.0" as const, id, result: value });

export default defineEventHandler(async (event) => {
  setNoIndex(event);
  setNoStore(event);

  // A browser page can't be the caller: the connector is server to server, and a page
  // on another origin posting here would be a rebinding attempt the spec says to refuse.
  const origin = getHeader(event, "origin");
  if (origin && origin !== trustedOrigin(event)) {
    setResponseStatus(event, 403);
    return error(null, -32600, "Origin not allowed");
  }
  const version = getHeader(event, "mcp-protocol-version");
  if (version && !MCP_PROTOCOL_VERSIONS.includes(version)) {
    setResponseStatus(event, 400);
    return error(null, -32600, `Unsupported protocol version ${version}; this server speaks ${MCP_PROTOCOL_VERSIONS.join(", ")} via initialize`);
  }

  // A budget refused is still a JSON-RPC answer. Left to throw, the limiter's 429
  // would arrive as the framework's error page, which a connector reads as the
  // server being unreachable rather than as something to wait out.
  //
  // Only a refused budget is a 429. This used to catch everything, so a KV store that
  // timed out or was briefly unreachable turned every request, initialize and
  // tools/list included, into "too many requests" from a server that had answered
  // none: down, to a connector and to every uptime check. Now a store that can't say
  // lets through what needs nothing it guards (the handshake, the tool list, a ping:
  // no database, no tool), and a tools/call is refused in the tool result, in words a
  // model can relay, since a tool's own work is what the budget protects and some of
  // it (search_catalog, the bearer lookup below) is limited by this bucket alone.
  //
  // A store that stops answering may never throw at all (and Upstash's client retries a
  // network fault for about four seconds before it does), so the wait is capped: past
  // it the budget is unknown, as if the store had failed.
  let budgetUnknown = false;
  try {
    await withinMs(rateLimit(event, "mcp"), BUDGET_WAIT.ms);
  } catch (e) {
    if ((e as { statusCode?: number })?.statusCode === 429) {
      setResponseStatus(event, 429);
      setHeader(event, "Retry-After", 60);
      return error(null, -32000, "Too many requests; wait a minute and try again");
    }
    budgetUnknown = true;
    logStoreFault(e);
  }

  const raw = await readRawBody(event, false).catch(() => undefined);
  if (raw && raw.length > MAX_BODY_BYTES) {
    setResponseStatus(event, 413);
    return error(null, -32600, "Request too large");
  }
  let message: unknown;
  try {
    message = raw?.length ? JSON.parse(raw.toString("utf8")) : undefined;
  } catch {
    setResponseStatus(event, 400);
    return error(null, -32700, "Parse error");
  }
  if (Array.isArray(message)) {
    setResponseStatus(event, 400);
    return error(null, -32600, "Batching is not supported; send one message per request");
  }
  if (!message || typeof message !== "object" || (message as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
    setResponseStatus(event, 400);
    return error(null, -32600, "Not a JSON-RPC 2.0 message");
  }
  const msg = message as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

  // a notification, or a response to a request this server never makes (a response
  // carries an id and a result or an error, and no method): accepted, no body
  if (msg.id === undefined || (typeof msg.method !== "string" && ("result" in msg || "error" in msg))) {
    setResponseStatus(event, 202);
    return send(event);
  }
  if (msg.id === null || (typeof msg.id !== "string" && typeof msg.id !== "number")) {
    setResponseStatus(event, 400);
    return error(null, -32600, "A request id must be a string or a number");
  }
  const id = msg.id as Id;
  if (typeof msg.method !== "string") {
    // Invalid Request, with the 400 every other one above carries
    setResponseStatus(event, 400);
    return error(id, -32600, "A request needs a method");
  }
  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;

  // A tool's arguments are an object. Some clients send them JSON-encoded a second
  // time, as a string; read as an object that string is no arguments at all, and a
  // get_list for a public list became the account's lists and a sign-in prompt. So a
  // string is parsed, and anything else that isn't an object is a protocol error.
  let args: unknown = params.arguments;
  if (msg.method === "tools/call") {
    // a blank string is a call with no arguments, as some function-calling bridges send
    // one, and as it read before strings were parsed
    if (typeof args === "string" && !args.trim()) args = undefined;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        // left as the string, and refused below
      }
    }
    if (args != null && (typeof args !== "object" || Array.isArray(args))) {
      return error(id, -32602, "arguments must be an object of the tool's parameters");
    }
    if (budgetUnknown) {
      return result(id, toolFailure("Mahonia couldn't check its request budget just now, so nothing was run. Try again in a minute."));
    }
  }

  // The account behind the bearer, for the calls that use one (accountUse, read off
  // the registry): resolved once here and left on the event. The gate is the scope
  // an account tool names; create_list only uses an account when there is one.
  const use = msg.method === "tools/call" && typeof params.name === "string" ? accountUse(params.name, args) : undefined;
  // An admin tool (verify_catalog_item, get_catalog_edits, revert_catalog_edit) is listed
  // only to an admin, and a live bearer that isn't an admin's gets the answer a name that
  // doesn't exist gets. With no bearer or a dead one it asks for a sign-in like any tool
  // that needs an account: the names are in the public source, so hiding them there
  // kept nothing secret, and an admin's lapsed token is refreshed the ordinary way.
  const adminTool = msg.method === "tools/call" && isAdminTool(params.name);
  const unknownTool = () => error(id, -32602, `Unknown tool: ${String(params.name ?? "")}`);
  if (use) {
    // Whether a bearer of ours was carried at all is the difference between "sign in"
    // and "sign in again"; the database is touched only when there is one to look up.
    const bearer = connectorToken(event);
    let identity: Awaited<ReturnType<typeof resolveBearer>> = null;
    if (bearer) {
      // a database fault here would otherwise leave as the framework's 500 page, which
      // a connector reads as the server gone, not as a call to try again
      try {
        identity = await resolveBearer(await useAccountDb(), bearer);
      } catch (e) {
        console.error("[mcp bearer]", e);
        return result(id, toolFailure("Mahonia couldn't check the sign-in just now, so nothing was run. Try again in a minute."));
      }
      event.context.connector = identity;
    }
    // An app's access token that opens nothing has almost always aged out, and its
    // client holds the refresh token: create_list answers it as the account tools do,
    // or the first list of a conversation an hour on is made but never filed. A
    // hand-minted token can't be refreshed, so a dead one still gets its list, with a
    // note beside the link saying why it wasn't filed.
    const refreshable = !identity && !!bearer?.startsWith(APP_ACCESS_PREFIX);
    if (!identity && (use !== "optional" || refreshable)) {
      return bearerChallenge(event, 401, bearer ? "That token no longer opens an account; sign in to Mahonia again." : "Sign in to Mahonia to reach your lists and My Gear.");
    }
    if (adminTool && !isAdmin(identity?.userId)) return unknownTool();
    if (use === "write" && identity?.scope !== "write") {
      return bearerChallenge(event, 403, "This connection can only read. To change your gear or your lists, connect Mahonia again and allow read-and-change access.");
    }
  }

  switch (msg.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return result(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_LATEST_VERSION,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        instructions: MCP_INSTRUCTIONS,
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      // one page, always: the tools fit without a cursor (six, or nine for an admin), and
      // a cursor that arrives anyway names a page this server never handed out
      if (params.cursor != null) return error(id, -32602, "Invalid cursor");
      return result(id, { tools: mcpToolsFor(await listingAccount(event)) });
    case "tools/call": {
      if (!isKnownTool(params.name)) return unknownTool();
      return result(id, await runTool(event, params.name, args));
    }
    default:
      return error(id, -32601, "Method not found");
  }
});

/** The account a tools/list is answered for, by its bearer: only an admin's list differs
 *  (mcpToolsFor), so no bearer, a dead one, or an account database that doesn't answer
 *  within the budget all get the public list rather than an error or a wait. With no
 *  admin configured there is nothing to look up. */
async function listingAccount(event: H3Event): Promise<number | undefined> {
  const bearer = connectorToken(event);
  if (!bearer || !anyAdmin()) return undefined;
  try {
    return (await withinMs((async () => resolveBearer(await useAccountDb(), bearer))(), BUDGET_WAIT.ms))?.userId;
  } catch {
    return undefined;
  }
}

/** the promise, or a rejection once `ms` pass without an answer */
function withinMs<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the budget store gave no answer in ${ms} ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The flood guard's store failing is logged once a minute per instance, not once per
 *  request: in an outage every request would otherwise write the same line. */
let lastStoreFault = 0;
function logStoreFault(e: unknown): void {
  const now = Date.now();
  if (now - lastStoreFault < 60_000) return;
  lastStoreFault = now;
  console.error("[mcp rate limit] the budget store failed; tool calls are refused until it answers", e);
}

/** A tool that throws answers with isError rather than a 500: the model reads the
 *  sentence and tries again, and a stack trace is not a sentence. Nothing about the
 *  failure is logged with the arguments, since an edit link may be among them. */
async function runTool(event: H3Event, name: string, args: unknown) {
  try {
    return await callTool(event, name, args);
  } catch (e) {
    // a rate limit, a 404 from the repo layer: the status line says what happened
    // and nothing else does
    const status = (e as { statusCode?: number; statusMessage?: string })?.statusCode;
    // a 409 is the list being saved from an open editor at the same moment, five times
    // running (listRepo): nothing was applied, and the same call again is the answer
    const text =
      status === 429
        ? "Too many requests; wait a minute and try again."
        : status === 404
          ? "Not found."
          : status === 409
            ? "The list was being saved from an open editor at the same moment, so nothing was changed; send the same call again."
            : "That didn't work; the request was well formed but the server could not complete it.";
    return toolFailure(text);
  }
}
