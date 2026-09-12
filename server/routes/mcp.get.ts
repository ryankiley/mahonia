import { defineEventHandler, setHeader, setResponseStatus } from "h3";
import { setNoIndex } from "../utils/http";

// The transport lets a server answer the endpoint's GET with 405 instead of an event
// stream, and a stateless server has no stream to offer. The body says what the URL
// is for, since a person will paste it into a browser to see. Never a 401 or 403:
// that is the signal Claude's clients read as "sign-in required".
export default defineEventHandler((event) => {
  setNoIndex(event);
  setResponseStatus(event, 405);
  setHeader(event, "Allow", "POST");
  setHeader(event, "Content-Type", "text/plain; charset=utf-8");
  return "This is Mahonia's MCP endpoint. Add this address to an AI assistant as a connector; it speaks JSON-RPC over POST.\n";
});
