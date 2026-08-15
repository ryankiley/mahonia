// Shared plumbing for suites that drive H3 responses and a stubbed network:
// the auth/session suites assert on Set-Cookie, and the favicon/SSRF suites
// stub fetch so they are hermetic. Each of these lived as a per-file copy
// (sessionLifecycle + passkeyCeremony; trailFavicon + ssrfRedirect) before
// moving here.

import type { H3Event } from "h3";
import { vi } from "vitest";

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
export function imageResponse(bytes: Uint8Array, contentType: string) {
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
    },
  };
}
