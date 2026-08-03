// The decisions behind "Send feedback", as pure functions.
//
// Extracted from the handler for the same reason shared/lighterpack.ts is extracted
// from the import route: the rules worth pinning down are about SHAPE — how long a
// message may be, what a repo reference is allowed to look like, and exactly what
// text ends up in a public issue — and none of them need an HTTP event to decide.
// The handler keeps the parts that genuinely do: throttling, auth, the fetch.
//
// In shared/ rather than server/utils/ because the LENGTH CAP has two enforcers: the
// dialog's maxlength and the endpoint's 413. They were separate literals that agreed
// by luck — lower one and the other silently disagrees, so the box accepts text the
// server rejects. One constant, imported by both.

/** Enforced server-side, not just in the dialog: the client cap is a courtesy, this
 *  is the rule. Long enough for a real bug report, short enough that an anonymous
 *  endpoint can't be used to post an essay. */
export const MAX_FEEDBACK_LEN = 500;

/** `owner/repo` — validated so a mis-set env var can't point the POST at an
 *  arbitrary path on api.github.com. */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function isFeedbackRepo(repo: string | undefined | null): boolean {
  return !!repo && REPO_RE.test(repo);
}

export interface FeedbackIssue {
  title: string;
  body: string;
  labels: string[];
}

/**
 * The issue a message becomes.
 *
 * The TITLE is fixed and never carries user text. A title is what renders in
 * notification emails, tab titles and search results — it is the most quotable
 * surface this endpoint has, and an anonymous stranger should not be able to write
 * it. The words go in the body instead, inside a fence, so no combination of
 * backticks, headings or @-mentions can restructure the issue or ping a maintainer.
 *
 * Any ``` the sender typed is neutralised rather than stripped: stripping would
 * silently alter a code sample, which is exactly the thing a bug report is most
 * likely to contain.
 */
export function buildFeedbackIssue(message: string): FeedbackIssue {
  const fenced = message.replace(/```/g, "'''");
  return {
    title: "App feedback",
    body: `Sent from the app.\n\n\`\`\`\n${fenced}\n\`\`\``,
    // labelled so a maintainer can filter, triage and — if this is ever abused —
    // bulk-close everything that came through this door
    labels: ["feedback", "from-app"],
  };
}
