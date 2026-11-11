import { normalizeShareCode } from "~~/shared/links";

/** What an editor address opens. Read by the editor's route watcher, which acts on it, and by
 *  the page that reads the list's on-device copy ahead of the editor (readAhead, useGearList),
 *  which has to land on the same IndexedDB key, so the rule lives here once. */
export type EditorCapability =
  /** the fragment's edit token */
  | { kind: "token"; token: string }
  /** a share code with no fragment, opened on the session */
  | { kind: "claimed"; code: string }
  /** a share code with no fragment for a list this browser holds the key to: restore it */
  | { kind: "held"; code: string; token: string }
  /** a share code with no fragment, no session and no key: a truncated edit link */
  | { kind: "keyless"; code: string }
  /** nothing to open: a fresh draft */
  | { kind: "draft" };

/**
 * Read an editor address (`/e`, `/e#{token}`, `/e/{code}`, `/e/{code}#{token}`).
 *
 * THROWS on a malformed fragment ("#%"), on purpose: the watcher calls this before it disposes
 * the session it holds, and that throw has always landed before the dispose.
 */
export function editorCapability(
  route: { hash: string; params: Record<string, unknown> },
  ctx: { hasSessionHint: () => boolean; heldToken: (code: string) => string | undefined },
): EditorCapability {
  const token = decodeURIComponent((route.hash || "").replace(/^#/, ""));
  if (token) return { kind: "token", token };
  // No token, but a code in the path: a claimed list, IF a session plausibly exists (the hint
  // cookie; the fetch itself is what proves it). For everyone else /e/{code} without a fragment
  // is a truncated link, handled below without a doomed request per visit.
  // Normalized here as well as in load(): a path segment that can't be a share code at all
  // (/e/garbage) falls through to the draft for the signed-in too, instead of spending a request
  // to be told 401.
  const param = route.params.code;
  const code = normalizeShareCode(typeof param === "string" ? param : "");
  if (code && ctx.hasSessionHint()) return { kind: "claimed", code };
  // A well-formed code, no key, no session: a truncated edit link. The editor says so and offers
  // the read-only view the same code opens, rather than landing a fresh draft under the dead
  // address (which read as "the list is empty"). No request is made: nothing could succeed
  // without a key or a session.
  // ...unless this browser holds the key itself. A list made or opened here is in the registry
  // with its token, so a truncated link to your OWN list opens it for editing (the fragment is
  // restored and the watcher runs again) rather than offering you the read-only view of it.
  const held = code ? ctx.heldToken(code) : undefined;
  if (held) return { kind: "held", code, token: held };
  return code ? { kind: "keyless", code } : { kind: "draft" };
}
