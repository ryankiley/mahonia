// THE SECOND BUTTON OF A PAIR IS CONTAINED. Beside a filled primary, a bare word reads
// as a caption on the button rather than a second thing to press, so wherever two
// buttons stand together the second wears .btn--soft: a dialog's Cancel, the sign-in
// link's "Not me" and "Not now", a missing list's "Create a list". Pinned by
// source: the rule is a class, and jsdom draws nothing.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8");
/** the classes on the element whose text is `label` */
const classesOf = (source: string, label: string) => {
  const at = source.indexOf(`>${label}<`);
  if (at < 0) return "";
  const open = source.lastIndexOf("<", at);
  return /class="([^"]*)"/.exec(source.slice(open, at))?.[1] ?? "";
};

describe("a dialog's Cancel", () => {
  it.each([
    "AppDialogs",
    "CatalogCorrectionModal",
    "FeedbackModal",
    "ImportModal",
    "VaultImportModal",
    "VaultItemModal",
    "VaultPickerModal",
  ])("is contained in %s", (name) => {
    expect(classesOf(read(`app/components/${name}.vue`), "Cancel")).toBe("btn btn--soft");
  });

  it("sits a pill's gap from the primary, now that both have edges", () => {
    const css = read("app/assets/styles/atoms/dialog.scss");
    const at = css.indexOf(".dlg__actions {");
    expect(css.slice(at, css.indexOf("}", at))).toContain("gap: var(--space-2)");
  });
});

describe("the second button of a pair on a page", () => {
  const link = read("app/components/SignInLinkDialog.vue");
  it.each(["Not me", "Not now"])("is contained in a sign-in link's question: %s", (label) => {
    expect(classesOf(link, label)).toBe("btn btn--soft");
  });

  it("is contained where a list is missing", () => {
    const editor = read("app/components/GearEditor.client.vue");
    expect(classesOf(editor, "Forget this list")).toBe("btn btn--soft");
    expect(editor).not.toMatch(/\? 'btn--quiet' : 'btn--primary'/);
  });
});
