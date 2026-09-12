import { describe, expect, it } from "vitest";
import { parseDevAllowedHosts } from "../config/devHosts";

describe("parseDevAllowedHosts", () => {
  it("keeps a narrow, normalized list for a trusted local proxy", () => {
    expect(parseDevAllowedHosts(" preview.local, .tunnel.test,preview.local, ")).toEqual([
      "preview.local",
      ".tunnel.test",
    ]);
  });

  it("leaves Vite's safe localhost/IP defaults intact when unset", () => {
    expect(parseDevAllowedHosts(undefined)).toEqual([]);
    expect(parseDevAllowedHosts("  ")).toEqual([]);
  });
});
