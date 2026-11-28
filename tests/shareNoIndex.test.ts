// Everything a share code resolves besides its page says noindex itself, because
// robots.txt leaves /s and /g open (tests/crawlerText.test.ts says why): the list's
// API, My Gear's, and the social card of each. Driven here as a request would hit them,
// with the lookups stubbed to find nothing: the header is set before a miss can throw,
// so a link that is off says it too. The Markdown twin and the connector hold the same
// line in their own suites (shareMarkdown.test.ts, mcp.test.ts).
//
// My Gear's API is never cached either. Its owner was told the link stops the moment
// they turn it off, and a copy held anywhere would keep answering.
import type { EventHandler, H3Event } from "h3";
import { describe, expect, it, vi } from "vitest";
import listApi from "../server/api/s/[code].get";
import gearApi from "../server/api/g/[code].get";
import listCard from "../server/routes/og/s/[code].get";
import gearCard from "../server/routes/og/g/[code].get";
import { makeEvent } from "./helpers/http";

vi.mock("../server/utils/listRepo", () => ({
  getByShareCode: async () => null,
  getCardByShareCode: async () => null,
}));
vi.mock("../server/utils/vaultShare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/utils/vaultShare")>()),
  sharedGearByCode: async () => null,
}));
vi.mock("../server/utils/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/utils/db")>()),
  useDb: async () => ({}),
}));
vi.mock("../server/utils/rateLimit", () => ({ rateLimit: async () => {} }));

/** The response headers of a request for a code nothing answers to. */
async function missing(handler: EventHandler, path: string): Promise<H3Event["node"]["res"]> {
  const event = makeEvent(path);
  await expect(handler(event)).rejects.toMatchObject({ statusCode: 404 });
  return event.node.res;
}

describe("a share code's other surfaces", () => {
  it.each([
    ["a list's API", listApi, "/api/s/GONE01"],
    ["My Gear's API", gearApi, "/api/g/GONE02"],
    ["a list's social card", listCard, "/og/s/GONE01"],
    ["My Gear's social card", gearCard, "/og/g/GONE02"],
  ])("%s says noindex", async (_name, handler, path) => {
    expect((await missing(handler, path)).getHeader("x-robots-tag")).toBe("noindex");
  });

  it("keeps My Gear's API out of every cache", async () => {
    expect((await missing(gearApi, "/api/g/GONE02")).getHeader("cache-control")).toBe("private, no-store");
  });
});
