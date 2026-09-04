// Shared plumbing for suites that drive H3 events and a stubbed network:
// the auth/session/gate suites build real events over bare node mocks and
// assert on Set-Cookie, and the favicon/SSRF suites stub fetch so they are
// hermetic. Each of these lived as a per-file copy (sessionLifecycle +
// passkeyCeremony + editAuthGate; trailFavicon + ssrfRedirect) before moving
// here.

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEvent, type H3Event } from "h3";
import { vi } from "vitest";

/**
 * A minimal REAL H3 event: enough request for getCookie / readRawBody / the
 * header reads, enough response for setCookie. No server boots — the event IS
 * the interface under test, so the code under it (cookie parsing, body
 * capping, header gates) runs exactly as a request would drive it.
 *
 * `cookie` is the Cookie header a browser would replay; `body` is JSON-encoded
 * with the content headers a fetch would send. Method defaults to POST when
 * there is a body and GET otherwise, which is what the endpoints these suites
 * boot expect.
 */
export function makeEvent(
  opts: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    cookie?: string;
    body?: unknown;
  } = {},
): H3Event {
  const req = new IncomingMessage(new Socket());
  req.method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  req.url = opts.url ?? "/";
  req.headers = { host: "mahonia.test", ...opts.headers };
  if (opts.cookie) req.headers.cookie = opts.cookie;
  if (opts.body !== undefined) {
    const buf = Buffer.from(JSON.stringify(opts.body));
    req.headers["content-type"] = "application/json";
    req.headers["content-length"] = String(buf.length);
    req.push(buf);
  }
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
 *  at least one assertion checks it round-trips into the stored data: URL. */
export function imageResponse(bytes: Uint8Array<ArrayBuffer>, contentType: string): Partial<Response> {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    body: new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}
