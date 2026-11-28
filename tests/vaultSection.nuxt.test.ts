// A section of gear remembers its collapse on this device only when it is given a key to
// remember it under: /gear passes one, and a shared gear page (/g) passes none, the way a
// shared list's folders keep nothing (ReadonlyFolderSection). A reader folding a section
// of someone else's gear leaves no trace in their browser.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import VaultSection from "~/components/VaultSection.vue";

enableAutoUnmount(afterEach);

beforeEach(() => localStorage.clear());

async function toggle(props: { label: string; collapseKey?: string }) {
  const w = mount(VaultSection, { props });
  await w.get(".folder__collapse").trigger("click");
  return w;
}

describe("a gear section's collapse", () => {
  it("is remembered under its key", async () => {
    const w = await toggle({ label: "Shelter", collapseKey: "shelter" });
    expect(w.get("section").attributes("data-collapsed")).toBe("true");
    expect(localStorage.getItem("gear.vkind.shelter")).toBe("1");
  });

  it("still folds without a key, and writes nothing down", async () => {
    const w = await toggle({ label: "Shelter" });
    expect(w.get("section").attributes("data-collapsed")).toBe("true");
    expect(localStorage.length).toBe(0);
  });
});
