import { describe, expect, it } from "vitest";
import { buildFeedbackIssue, isFeedbackRepo, MAX_FEEDBACK_LEN } from "../shared/feedback";

// The feedback endpoint is anonymous and its output is PUBLIC — every message
// becomes an issue in a repository anyone can read. So the rules pinned here are
// the ones a hostile sender would go looking for: what they can put in the title
// (nothing), what they can do to the body's structure (nothing), and where the POST
// can be aimed (one repo).

describe("isFeedbackRepo", () => {
  it("accepts a plain owner/repo", () => {
    expect(isFeedbackRepo("ryankiley/mahonia")).toBe(true);
    expect(isFeedbackRepo("some-org/my.repo_name")).toBe(true);
  });

  it("rejects anything that could steer the request off that repo", () => {
    // the value is interpolated into an api.github.com path, so a slash or a dot
    // segment is the whole attack surface of a mis-set env var
    expect(isFeedbackRepo("owner/repo/issues/1")).toBe(false);
    expect(isFeedbackRepo("../../orgs/evil")).toBe(false);
    expect(isFeedbackRepo("owner")).toBe(false);
    expect(isFeedbackRepo("owner/")).toBe(false);
    expect(isFeedbackRepo("/repo")).toBe(false);
    expect(isFeedbackRepo("owner/repo?x=1")).toBe(false);
    expect(isFeedbackRepo("owner repo")).toBe(false);
  });

  it("rejects absent config rather than treating it as valid", () => {
    expect(isFeedbackRepo(undefined)).toBe(false);
    expect(isFeedbackRepo(null)).toBe(false);
    expect(isFeedbackRepo("")).toBe(false);
  });
});

describe("buildFeedbackIssue", () => {
  it("never puts user text in the title", () => {
    const issue = buildFeedbackIssue("Ping @maintainer, this is urgent");
    expect(issue.title).toBe("App feedback");
    expect(issue.title).not.toContain("maintainer");
    expect(issue.title).not.toContain("urgent");
  });

  it("carries the message in a fenced block", () => {
    const issue = buildFeedbackIssue("the weight column is wrong");
    expect(issue.body).toContain("```\nthe weight column is wrong\n```");
  });

  it("neutralises a fence the sender typed, so they can't break out of the block", () => {
    // without this, "```\n# Heading" would close our fence and let the rest of the
    // message write real markdown into the issue
    const issue = buildFeedbackIssue("```\n# Not a heading\n```");
    expect(issue.body).not.toContain("```\n# Not a heading");
    expect(issue.body).toContain("'''");
    // and the fence that remains is exactly the pair we opened and closed with
    expect(issue.body.match(/```/g)).toHaveLength(2);
  });

  it("keeps the sender's words intact rather than stripping them", () => {
    // a bug report is the text most likely to contain a code sample; mangling is
    // acceptable, silent deletion is not
    const issue = buildFeedbackIssue("crash on ```npm run build```");
    expect(issue.body).toContain("crash on '''npm run build'''");
  });

  it("labels every issue so it can be filtered and bulk-closed", () => {
    expect(buildFeedbackIssue("hi").labels).toEqual(["feedback", "from-app"]);
  });

  it("agrees with the dialog's character cap", () => {
    // the dialog uses maxlength=500; the server enforces the same number, and a
    // drift between them would either truncate silently or reject a valid message
    expect(MAX_FEEDBACK_LEN).toBe(500);
  });
});
