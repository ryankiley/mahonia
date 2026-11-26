// ONE RHYTHM FOR THE BAR'S ICONS. Its buttons are 32px under a mouse and 44px under a
// finger, and with one gap for both the cluster ran 40px apart on a desktop, 36 in a
// narrow window and 48 on a phone. The gap is now what is left of a touch target after
// the button, so the icons sit one touch target apart everywhere. Pinned by source: the
// rule is a few declarations, and jsdom lays nothing out.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const editor = readFileSync(resolve(__dirname, "../app/components/GearEditor.client.vue"), "utf8");
const styles = editor.slice(editor.lastIndexOf("<style"));
const block = (selector: string) => {
  const at = styles.indexOf(`\n${selector} {`);
  return at < 0 ? "" : styles.slice(at, styles.indexOf("\n}", at));
};

describe("the editor bar's icon spacing", () => {
  const bar = block(".topbar__inner");

  it("is a touch target less the button, so it closes to nothing on touch", () => {
    expect(bar).toContain("--cluster-gap: calc(var(--tap) - var(--icon-btn));");
    expect(bar).toContain("gap: var(--cluster-gap);");
    expect(bar).toMatch(/@media \(pointer: coarse\) \{\s*--cluster-gap: 0px;/);
    // and no width breakpoint of its own any more
    expect(bar).not.toContain("gap: var(--space-1)");
    expect(bar).not.toContain("gap: var(--space-2)");
  });

  it("keeps the status line its own distance from the switcher, whatever that gap is", () => {
    expect(block(".topbar__status")).toContain("margin-left: calc(var(--space-2) - var(--cluster-gap));");
  });
});
