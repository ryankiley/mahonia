import { describe, expect, it } from "vitest";
import { lighterpackId } from "../shared/lighterpack";

describe("lighterpackId — strict LighterPack URL allowlist (SSRF guard)", () => {
  it("accepts lighterpack.com share / csv / edit links", () => {
    expect(lighterpackId("https://lighterpack.com/r/abc123")).toBe("abc123");
    expect(lighterpackId("https://www.lighterpack.com/r/abc123")).toBe("abc123");
    expect(lighterpackId("https://lighterpack.com/csv/XyZ_9-0")).toBe("XyZ_9-0");
    expect(lighterpackId("http://lighterpack.com/e/abc123/")).toBe("abc123");
    expect(lighterpackId("  https://lighterpack.com/r/abc123  ")).toBe("abc123");
  });

  it("rejects any non-lighterpack host (no SSRF)", () => {
    for (const u of [
      "https://evil.com/r/x",
      "https://lighterpack.com.evil.com/r/x",
      "https://evil.com/lighterpack.com/r/x",
      "https://lighterpack.evil.com/r/x",
      "https://lighterpack.com@evil.com/r/x", // userinfo-bypass — host is evil.com
      "https://evil.com@lighterpack.com.evil.com/r/x",
      "https://169.254.169.254/r/x",
      "http://localhost/r/x",
      "http://127.0.0.1/r/x",
      "https://notlighterpack.com/r/x",
    ]) {
      expect(lighterpackId(u), u).toBeNull();
    }
  });

  it("rejects non-http(s) schemes, bad paths, and bad ids", () => {
    for (const u of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://lighterpack.com/",
      "https://lighterpack.com/r/",
      "https://lighterpack.com/account",
      "https://lighterpack.com/r/has spaces",
      "https://lighterpack.com/r/../../etc",
      "not a url",
      "",
    ]) {
      expect(lighterpackId(u), u).toBeNull();
    }
  });

  it("returns null (never throws) on malformed percent-encoding in the id", () => {
    // decodeURIComponent throws URIError on these; the importer must get null, not a 500
    for (const u of [
      "https://lighterpack.com/r/%E0%A4%A",
      "https://lighterpack.com/csv/%",
      "https://lighterpack.com/e/%C3%28",
    ]) {
      expect(() => lighterpackId(u), u).not.toThrow();
      expect(lighterpackId(u), u).toBeNull();
    }
  });
});
