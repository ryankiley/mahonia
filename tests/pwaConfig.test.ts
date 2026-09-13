import { describe, expect, it } from "vitest";
import { pwaPrecacheRevision } from "../config/pwa";

describe("pwaPrecacheRevision", () => {
  it("uses a unique Vercel deployment ID ahead of the commit SHA", () => {
    expect(
      pwaPrecacheRevision(
        { VERCEL_DEPLOYMENT_ID: "dpl_second", VERCEL_GIT_COMMIT_SHA: "same-commit" },
        "local-build",
      ),
    ).toBe("dpl_second");
  });

  it("falls back to the commit SHA, then a local-build revision", () => {
    expect(pwaPrecacheRevision({ VERCEL_GIT_COMMIT_SHA: "commit" }, "local-build")).toBe("commit");
    expect(pwaPrecacheRevision({}, "local-build")).toBe("local-build");
  });
});
