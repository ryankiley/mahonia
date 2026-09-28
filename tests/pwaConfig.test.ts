import { describe, expect, it } from "vitest";
import { PWA_OPTIONS, pwaPrecacheRevision } from "../config/pwa";

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

describe("the precache", () => {
  it("leaves the catalog product pages out", () => {
    // @vite-pwa/nuxt adds `**/_payload.json` to the precache of every prerendering
    // app; the 2,300 product pages under /catalog each have one, and none of them
    // is the shell (config/pwa.ts says the rest). A build check would be the real
    // gate — this pins the one line that keeps them out.
    expect(PWA_OPTIONS.workbox?.globIgnores).toContain("catalog/**");
    expect(PWA_OPTIONS.workbox?.globPatterns).toEqual(["**/*.{js,css,woff2}"]);
  });
});
