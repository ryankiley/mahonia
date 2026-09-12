import { defineEventHandler, getHeader, readRawBody, send, setHeader, setResponseStatus, type H3Event } from "h3";
import { MCP_INSTRUCTIONS, MCP_LATEST_VERSION, MCP_PROTOCOL_VERSIONS, MCP_SERVER_INFO, MCP_TOOLS, callTool, isKnownTool } from "../utils/mcp";
import { setNoIndex } from "../utils/http";
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
// No authentication, on purpose: a share code is already the read capability and an
// edit link the write one, and both travel as tool arguments (server/utils/mcp.ts).
// The endpoint must never answer 401 or 403 to a well-formed request, because that
// is the signal Claude's clients read as "this server wants a sign-in".

/** a JSON-RPC body is small; a list's rows arrive a few hundred at most */
const MAX_BODY_BYTES = 262_144;
type Id = string | number;

const error = (id: Id | null, code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });
const result = (id: Id, value: unknown) => ({ jsonrpc: "2.0" as const, id, result: value });

export default defineEventHandler(async (event) => {
  setNoIndex(event);
  setHeader(event, "Cache-Control", "no-store");

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
  try {
    await rateLimit(event, "mcp");
  } catch {
    setResponseStatus(event, 429);
    return error(null, -32000, "Too many requests; wait a minute and try again");
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
  if (typeof msg.method !== "string") return error(id, -32600, "A request needs a method");
  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;

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
      // one page, always: seven tools need no cursor, and a cursor that arrives anyway
      // names a page this server never handed out
      if (params.cursor != null) return error(id, -32602, "Invalid cursor");
      return result(id, { tools: MCP_TOOLS });
    case "tools/call": {
      if (!isKnownTool(params.name)) return error(id, -32602, `Unknown tool: ${String(params.name ?? "")}`);
      return result(id, await runTool(event, params.name, params.arguments));
    }
    default:
      return error(id, -32601, "Method not found");
  }
});

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
    const text = status === 429 ? "Too many requests; wait a minute and try again." : status === 404 ? "Not found." : "That didn't work; the request was well formed but the server could not complete it.";
    return { content: [{ type: "text" as const, text }], isError: true };
  }
}
