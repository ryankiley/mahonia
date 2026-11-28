// A share link's page keeps itself out of search with its own noindex tag, because
// robots.txt leaves /s and /g open (tests/crawlerText.test.ts says why). The tag is
// there whether or not the link resolves, so a link that is off says it too.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSuspended, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount } from "@vue/test-utils";
import ListSharePage from "~/pages/s/[code].vue";
import GearSharePage from "~/pages/g/[code].vue";
import { blankList } from "./helpers/list";

registerEndpoint("/api/s/LIVE01", () => ({ snapshot: blankList({ shareCode: "LIVE01", title: "Timberline" }) }));
registerEndpoint("/api/g/LIVE02", () => ({ items: [] }));

enableAutoUnmount(afterEach);

const robots = () => [...document.head.querySelectorAll('meta[name="robots"]')].map((m) => m.getAttribute("content"));

describe("a share link's page", () => {
  it.each([
    ["a list's", ListSharePage, "/s/LIVE01"],
    ["a list's, for a link that is off", ListSharePage, "/s/GONE01"],
    ["My Gear's", GearSharePage, "/g/LIVE02"],
    ["My Gear's, for a link that is off", GearSharePage, "/g/GONE02"],
  ])("%s says noindex", async (_name, page, route) => {
    await mountSuspended(page, { route });
    await vi.waitFor(() => expect(robots()).toEqual(["noindex"]), { interval: 25 });
  });
});
