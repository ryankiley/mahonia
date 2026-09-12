// @vitest-environment nuxt
//
// A list edit token survives account changes on a shared device. The local answer
// to "is this gear mine?" must therefore belong to the resolved account, not just
// the token.
import { beforeEach, describe, expect, it } from "vitest";
import { stubLocalStorage } from "./helpers/storage";
import {
  setVaultConsentScope,
  setVaultDecisionFor,
  setVaultExclusionsFor,
  vaultDecisionFor,
  vaultExclusionsFor,
} from "~/composables/useVault";

const storage = stubLocalStorage();
const TOKEN = "shared-edit-token";

beforeEach(() => {
  storage.clear();
  setVaultConsentScope("a@example.com", true);
});

describe("vault consent ownership", () => {
  it("never lets B inherit A's automatic-capture consent or exclusions", () => {
    setVaultDecisionFor(TOKEN, "yes");
    setVaultExclusionsFor(TOKEN, ["their stove"]);
    expect(vaultDecisionFor(TOKEN)).toBe("yes");
    expect([...vaultExclusionsFor(TOKEN)]).toEqual(["their stove"]);

    setVaultConsentScope("b@example.com", true);
    expect(vaultDecisionFor(TOKEN)).toBe("ask");
    expect(vaultExclusionsFor(TOKEN)).toEqual(new Set());
  });

  it("does not use persisted consent while a replacement cookie is unresolved", () => {
    setVaultDecisionFor(TOKEN, "yes");
    setVaultConsentScope(null, false);
    expect(vaultDecisionFor(TOKEN)).toBe("ask");
  });
});
