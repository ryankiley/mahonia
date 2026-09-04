import { createError, defineEventHandler } from "h3";
import { buildFeedbackIssue, isFeedbackRepo, MAX_FEEDBACK_LEN } from "../../shared/feedback";
import { readJsonBodyCapped, setNoIndex } from "../utils/http";
import { rateLimit } from "../utils/rateLimit";

// "Send feedback" — one textarea, filed as a GitHub issue.
//
// NO SDK and no Octokit: creating an issue is a single POST with a JSON body, so a
// plain fetch does the whole job and the runtime dependency list (nine packages)
// stays as it is. Same reasoning, and the same shape, as server/utils/email.ts —
// which is also where the dev-vs-production rule below comes from.
//
// The endpoint is ANONYMOUS, like everything else here: Mahonia has no login
// requirement, and demanding an account to report a bug would be the one place the
// app asked you to sign in for something that isn't yours. That makes throttling
// the whole defence, so the bucket is the tightest in the app.

const GITHUB_API = "https://api.github.com";

/** A production deploy with no usable repo or token. One error for both ways
 *  of being misconfigured — the sender learns nothing about which. */
const notConfigured = () => createError({ statusCode: 500, statusMessage: "Feedback isn't configured" });

export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "feedback");

  const body = await readJsonBodyCapped<{ message?: string }>(event, 4_000);
  const message = (typeof body?.message === "string" ? body.message : "").trim();
  if (!message) throw createError({ statusCode: 400, statusMessage: "Say something first" });
  if (message.length > MAX_FEEDBACK_LEN)
    throw createError({ statusCode: 413, statusMessage: "That's longer than 500 characters" });

  const token = process.env.GITHUB_FEEDBACK_TOKEN;
  const repo = process.env.GITHUB_FEEDBACK_REPO;

  // WITH NO TOKEN THE APP STILL WORKS LOCALLY, exactly as the magic-link mail does:
  // `npm run dev` against a fresh checkout has no GITHUB_FEEDBACK_TOKEN, and the
  // README's promise is that the app runs fully on your machine with no environment
  // variables. So in development the message is printed to the server console
  // instead of filed, and the dialog's "thanks" is honest about what happened.
  if (!token || !repo) {
    if (process.env.NODE_ENV === "production") {
      // A production deploy that silently swallows feedback is worse than a loud
      // failure: the sender is told it was sent, and it goes nowhere forever.
      throw notConfigured();
    }
    console.info(`[feedback] ${message}`);
    return { ok: true, filed: false };
  }

  if (!isFeedbackRepo(repo)) throw notConfigured();

  // the fixed title + fenced body rule lives in shared/feedback (and is tested
  // there) — it is the part of this endpoint most worth pinning down
  const payload = buildFeedbackIssue(message);

  try {
    const res = await fetch(`${GITHUB_API}/repos/${repo}/issues`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "mahonia-feedback",
      },
      body: JSON.stringify(payload),
    });
    // The status is deliberately NOT forwarded. GitHub's errors are about our repo
    // and our token — a 401 or a 404 here is our misconfiguration, and echoing it
    // would tell a sender something about our infrastructure rather than about
    // their message.
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    throw createError({ statusCode: 502, statusMessage: "Couldn't send that just now" });
  }

  return { ok: true, filed: true };
});
