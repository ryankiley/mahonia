// The copy-link fallback, shown when the clipboard refuses a write: the link sits in a
// read-only field, selected, so it is one keystroke to copy by hand. The dialogs mount on
// their first use, already open, so the first time is the one a watch on `open` never
// hears; the field is selected as it reaches the page, on that open and every later one.
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import AppDialogs from "~/components/AppDialogs.vue";

enableAutoUnmount(afterEach);
afterEach(() => useDialogs().closeLinkFallback());

const URL = "https://mahonia.app/s/C0DE00000001";
const linkField = () => document.querySelector<HTMLInputElement>(".dlg__linkfield");
const selected = (el: HTMLInputElement | null) => (el ? [el.selectionStart, el.selectionEnd] : null);

describe("the copy-link fallback", () => {
  it("has the link selected when it is the first dialog the page opens", async () => {
    useDialogs().showLinkFallback(URL);
    mount(AppDialogs, { attachTo: document.body });
    await flushPromises();
    expect(selected(linkField())).toEqual([0, URL.length]);
  });

  it("has it selected on a later open too", async () => {
    mount(AppDialogs, { attachTo: document.body });
    await flushPromises();
    useDialogs().showLinkFallback(URL);
    await flushPromises();
    expect(selected(linkField())).toEqual([0, URL.length]);
  });
});
