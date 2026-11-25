// <ItemName search>: the share page's name is a web-search link for a product, and
// plain text for anything that is not one. A group's name is a heading its owner wrote
// over the rows inside it; "Search the web for Tent" on it looked up a word, not gear.
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import ItemName from "~/components/ItemName.vue";
import { item } from "./helpers/list";

enableAutoUnmount(afterEach);

const tent = item({ id: "t", brand: "Durston", name: "X-Mid 2" });
const link = (props: InstanceType<typeof ItemName>["$props"]) => mount(ItemName, { props }).find("a");

describe("<ItemName search>", () => {
  it("links a product to a web search for its brand and name", () => {
    const a = link({ item: tent, search: true });
    expect(a.attributes("href")).toBe("https://www.google.com/search?q=Durston%20X-Mid%202");
    expect(a.attributes("aria-label")).toBe("Search the web for Durston X-Mid 2");
  });

  it("leaves a group's name as text", () => {
    const w = mount(ItemName, { props: { item: item({ id: "g", name: "Tent" }), search: true, group: true } });
    expect(w.find("a").exists()).toBe(false);
    expect(w.text()).toBe("Tent");
  });

  it("links nothing without `search`, and never water", () => {
    expect(link({ item: tent }).exists()).toBe(false);
    expect(link({ item: item({ id: "w", name: "Water" }), search: true }).exists()).toBe(false);
  });
});
