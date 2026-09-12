// Shared plumbing for suites that drive H3 responses and a stubbed network:
// the auth/session suites assert on Set-Cookie, and the favicon/SSRF suites
// stub fetch so they are hermetic. Each of these lived as a per-file copy
// (sessionLifecycle + passkeyCeremony; trailFavicon + ssrfRedirect) before
// moving here. makeEvent is the same story (shareMarkdown + crawlerText).

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEvent, type H3Event } from "h3";
import { vi } from "vitest";

/** A minimal real H3 event over bare node mocks: a method, a URL and headers, which
 *  is all a handler under test reads. No server boots — the event IS the interface
 *  under test. `host` is always set, because anything that builds a URL from the
 *  request (getRequestURL; the robots/llms/sitemap routes) needs one. */
export function makeEvent(
  url: string,
  { method = "GET", headers = {} }: { method?: string; headers?: Record<string, string> } = {},
): H3Event {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = url;
  req.headers = { host: "mahonia.test", ...headers };
  req.push(null);
  return createEvent(req, new ServerResponse(req));
}

/** What the response set a cookie to, or null if it never touched that cookie. */
export function setCookieValue(event: H3Event, name: string): string | null {
  const header = event.node.res.getHeader("set-cookie");
  const all = header == null ? [] : Array.isArray(header) ? header : [header];
  const hit = all.map(String).find((c) => c.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1).split(";")[0]! : null;
}

/** Stub fetch AND return the log of every URL actually requested — some suites
 *  assert as much about what was never fetched as about what came back. Callers
 *  that only need the stub ignore the log. */
export function stubFetch(impl: (url: string) => Partial<Response> | null): string[] {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    fetched.push(url);
    const res = impl(url);
    if (!res) throw new Error("network down");
    return res as Response;
  });
  return fetched;
}

/** A one-chunk streamed body with the given content type — the shape the
 *  favicon fetcher reads. `contentType` is explicit at every call site because
 *  at least one assertion checks it round-trips into the stored data: URL.
 *
 *  `body` is a getReader() stub, not a ReadableStream: the reader is the whole
 *  interface the fetcher touches, and a real stream would mean constructing one
 *  per case to prove nothing extra. The cast is where that shortcut is declared —
 *  widen it to a real stream here, once, if a caller ever needs `tee`, `cancel`
 *  or async iteration. */
export function imageResponse(bytes: Uint8Array, contentType: string): Partial<Response> {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { value: undefined, done: true };
            sent = true;
            return { value: bytes, done: false };
          },
          async cancel() {},
        };
      },
    } as unknown as Response["body"],
  };
}
