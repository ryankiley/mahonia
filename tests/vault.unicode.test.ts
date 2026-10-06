import { describe, expect, it } from "vitest";
import { vaultNormKey } from "../shared/vault";
describe("Chinese gear identities", () => {
  it("retains Chinese-only gear and distinguishes variants", () => {
    expect(vaultNormKey(null,"眼罩",null)).toBe("眼罩");
    expect(vaultNormKey(null,"充电线",null)).not.toBe(vaultNormKey(null,"急救包",null));
    expect(vaultNormKey(null,"Trekology 登山杖（裸杖）",null)).not.toBe(vaultNormKey(null,"Trekology 登山杖（含配件）",null));
  });
  it("keeps Latin case, punctuation and accent normalization", () => {
    expect(vaultNormKey(null,"ZPÁCKS  Duplex!",null)).toBe("zpacks duplex");
  });
});
