// The "fix a catalog weight" endpoint, driven as a request would hit it. A product takes
// only a few edits an hour across everyone (the per-item throttle), so a weight that
// can't be one is refused before it spends one. The dialog sends milligrams; the text
// form is still read for a tab running the build before that.
import { beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../server/api/catalog/correct.post";
import { makeEvent } from "./helpers/http";

const { spent, proposed } = vi.hoisted(() => ({
  spent: vi.fn(async () => false),
  proposed: vi.fn(async (_db: unknown, input: { newWeightMg: number }) => ({ status: "applied", weightMg: input.newWeightMg })),
}));

vi.mock("../server/utils/rateLimit", () => ({
  rateLimit: async () => {},
  consumeRateLimit: spent,
  useKv: () => ({}),
}));
vi.mock("../server/utils/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/utils/catalog")>()),
  proposeCorrection: proposed,
}));
vi.mock("../server/utils/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/utils/db")>()),
  useDb: async () => ({}),
}));

const post = (body: unknown) => handler(makeEvent("/api/catalog/correct", { method: "POST", body }));

beforeEach(() => {
  spent.mockClear();
  proposed.mockClear();
});

describe("proposing a catalog weight", () => {
  it.each([
    ["text that is no weight", { catalogItemId: 5, weight: "about right" }],
    ["a zero", { catalogItemId: 5, weightMg: 0 }],
    ["no weight at all", { catalogItemId: 5 }],
  ])("refuses %s without spending the product's hourly edit", async (_name, body) => {
    await expect(post(body)).rejects.toMatchObject({ statusCode: 400 });
    expect(spent).not.toHaveBeenCalled();
    expect(proposed).not.toHaveBeenCalled();
  });

  it("takes the milligrams the dialog sends", async () => {
    await post({ catalogItemId: 5, weightMg: 540_000 });
    expect(spent).toHaveBeenCalledTimes(1);
    expect(proposed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ catalogItemId: 5, newWeightMg: 540_000 }));
  });

  it("still reads the text an older tab sends", async () => {
    await post({ catalogItemId: 5, weight: "1.2 kg" });
    expect(proposed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ newWeightMg: 1_200_000 }));
  });
});
