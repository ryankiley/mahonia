import { defineEventHandler, setHeader, setResponseStatus } from "h3";
import { setNoIndex } from "../utils/http";

// A client ending a session sends DELETE; this server issues no sessions, and the
// transport lets it say so with a 405.
export default defineEventHandler((event) => {
  setNoIndex(event);
  setResponseStatus(event, 405);
  setHeader(event, "Allow", "POST");
  return "";
});
