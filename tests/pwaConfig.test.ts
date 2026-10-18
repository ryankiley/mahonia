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

describe("the editor shell offline", () => {
  const rules = PWA_OPTIONS.workbox?.runtimeCaching ?? [];
  const shell = rules.find(
    (r) => r.urlPattern instanceof RegExp && r.urlPattern.test("/e/abc123"),
  );

  it("precaches /e, stamped per build like /", () => {
    const urls = (PWA_OPTIONS.workbox?.additionalManifestEntries ?? []).map((e) =>
      typeof e === "string" ? e : e.url,
    );
    expect(urls).toEqual(expect.arrayContaining(["/", "/e"]));
  });

  // A runtime-cached copy of an /e page names the chunks of the build it came from,
  // which the next deploy's worker deletes — so the page itself must never be served
  // from cache, only the precached /e that matches the live chunks.
  it("serves every edit link from the network, falling back to the precached /e", () => {
    expect(shell?.handler).toBe("NetworkOnly");
    expect(shell?.options?.precacheFallback).toEqual({ fallbackURL: "/e" });
    expect(shell?.options?.cacheName).toBeUndefined();
    for (const path of ["/e", "/e/", "/e/abc123"]) {
      expect((shell?.urlPattern as RegExp).test(path)).toBe(true);
    }
  });
});
