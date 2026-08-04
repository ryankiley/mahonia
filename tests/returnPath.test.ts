import { describe, expect, it } from "vitest";
import { isSafeReturnPath } from "../shared/links";

// The guard on the post-sign-in redirect. Everything here is an OPEN REDIRECT test:
// the value it screens has round-tripped through localStorage, so it is attacker-
// adjacent by the time it reaches this function, and a pass sends someone to another
// origin with the app's name on the referrer.
describe("isSafeReturnPath — the post-sign-in redirect guard", () => {
  it("accepts ordinary same-origin paths, hash and query included", () => {
    for (const p of [
      "/",
      "/vault",
      "/s/WC98FBTG153E",
      "/e/ABC123#tok_secret", // the editor's token lives in the fragment
      "/mine?sort=name",
      "/l/sierra-high-route",
    ]) {
      expect(isSafeReturnPath(p), p).toBe(true);
    }
  });

  it("rejects protocol-relative paths — the one that looks safe", () => {
    // "//evil.com" starts with "/", so a leading-slash test alone passes it, and the
    // browser then reads it as an absolute URL to another origin.
    for (const p of ["//evil.com", "//evil.com/path", "///evil.com"]) {
      expect(isSafeReturnPath(p), p).toBe(false);
    }
  });

  it("rejects backslashes, which some engines normalise to slashes", () => {
    for (const p of ["/\\evil.com", "\\\\evil.com", "/path\\..\\..\\x"]) {
      expect(isSafeReturnPath(p), p).toBe(false);
    }
  });

  it("rejects absolute URLs and non-path schemes", () => {
    for (const p of [
      "https://evil.com",
      "http://evil.com",
      "javascript:alert(1)",
      "data:text/html,<script>",
      "mailto:a@b.c",
    ]) {
      expect(isSafeReturnPath(p), p).toBe(false);
    }
  });

  it("rejects anything that isn't a string, and anything not rooted at /", () => {
    for (const p of [null, undefined, 42, {}, [], "", "vault", "./vault", "../vault"]) {
      expect(isSafeReturnPath(p), String(p)).toBe(false);
    }
  });
});
