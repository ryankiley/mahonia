// The share page's folder names are the page's outline: an h2 each, under the list's
// h1 and beside "The trip". They were bare spans, so a screen reader's heading list
// for a shared list held its title and nothing else.
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import ReadonlyFolderSection from "~/components/ReadonlyFolderSection.vue";
import { folder } from "./helpers/list";

enableAutoUnmount(afterEach);

describe("the share page's folder", () => {
  it("names itself in an h2 that keeps the name's class", () => {
    const w = mount(ReadonlyFolderSection, { props: { folder: folder({ name: "Shelter" }), items: [] } });
    const heading = w.get("h2");
    expect(heading.text()).toBe("Shelter");
    expect(heading.classes()).toContain("folder__name");
  });
});
