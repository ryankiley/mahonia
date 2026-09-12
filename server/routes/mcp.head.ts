// HEAD is GET without the body, and Nitro routes by method, so without this file a
// HEAD to the endpoint fell past every handler to the app's 404 page. The GET handler
// answers it: Node's server drops the body of a HEAD on its own, so what goes out is
// the 405, the Allow header and the noindex, which is what a HEAD is asking for.
export { default } from "./mcp.get";
