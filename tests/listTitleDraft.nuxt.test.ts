// @vitest-environment nuxt
//
// The list title survives having the snapshot replaced under it.
//
// Needs a booted Nuxt because what's under test is a BINDING, not a decision: the
// field used to read `:value="snapshot.title"`, and a Vue value-binding re-patches
// the DOM whenever the bound value changes. So replacing the snapshot mid-word
// rewrote the box, and only the characters typed AFTER the replacement were still
// there to be committed on blur — a three-word name came back as its last word.
//
// The controller replaces the snapshot in four places. flush() and the poll skip it
// while a field has focus (`if (!isEditing)`); load() and createFromDraft() cannot,
// because both have to install a snapshot to have an editor at all — load() adopts
// the server's copy over the local one it painted first, createFromDraft() adopts
// the list it just created. Both land on exactly the beat you'd be naming a list on:
// straight after opening a duplicate, or straight after a new list's first save.
// Hence the fix at the field rather than at those call sites, and hence these cases
// drive a prop change rather than either function.
//
// TYPING IS `input`, NOT setValue. @vue/test-utils' setValue fires change as well,
// which is the COMMIT — it would test the one path that was never broken and skip
// the one that was, since the hazard is uncommitted text.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { mount } from "@vue/test-utils";
import { reactive } from "vue";
import ListHead from "~/components/ListHead.vue";
import { applyOps } from "~~/shared/ops";
import type { ListSnapshot } from "~~/shared/types";

// The stubbed controller writes through the REAL reducer, into whichever snapshot
// the test is holding. That matters: commit resyncs the box from the stored value,
// so a stub that only records would put the pre-edit title straight back and every
// case here would pass or fail for the wrong reason. It also means the tidy under
// test is the actual one.
let current: ListSnapshot;
const setMeta = vi.fn((patch: Record<string, unknown>) => {
  applyOps(current, [{ t: "setMeta", patch } as Parameters<typeof applyOps>[1][number]]);
});
mockNuxtImport("useGearList", () => () => ({ setMeta }));

const snap = (title: string): ListSnapshot => ({
  shareCode: "SNAPCODE0001",
  slug: "test-list-aaa111",
  title,
  description: "",
  displayUnit: "g",
  folders: [],
  items: [],
  version: 1,
  isPublic: false,
});

function open(title: string) {
  current = reactive(snap(title)) as ListSnapshot;
  const wrapper = mount(ListHead, { props: { snapshot: current } });
  const field = wrapper.find("textarea.head__title");
  const el = field.element as HTMLTextAreaElement;
  return {
    wrapper,
    field,
    shown: () => el.value,
    /** what a person does: keystrokes, no commit */
    type: async (v: string) => {
      el.value = v;
      await field.trigger("input");
    },
    /** blur or Enter */
    commit: async () => {
      await field.trigger("change");
      await field.trigger("blur");
    },
  };
}

describe("the list title while you're typing in it", () => {
  beforeEach(() => {
    setMeta.mockClear();
  });

  // The regression. "South Sister Summit", typed into a box that gets rewritten
  // after "South Sister " has gone in, commits as "Summit" — the reported shape.
  it("keeps what you typed when the snapshot is replaced mid-word", async () => {
    const t = open("Ryan’s Loowit (copy)");
    await t.field.trigger("focus");
    await t.type("South Sister Summit");

    // load()'s server copy landing over the local one it painted first
    await t.wrapper.setProps({ snapshot: snap("Ryan’s Loowit (copy)") });

    expect(t.shown()).toBe("South Sister Summit");

    // ...and the commit carries the whole name, not its tail
    await t.commit();
    expect(setMeta).toHaveBeenCalledWith({ title: "South Sister Summit" });
  });

  // Even when the replacement carries a DIFFERENT name — a collaborator renaming the
  // list while you're naming it. Yours is the one in your hands; it wins until you
  // leave.
  it("is not overwritten by a rename that arrives while the field has focus", async () => {
    const t = open("Ryan’s Loowit (copy)");
    await t.field.trigger("focus");
    await t.type("South Sister Summit");

    await t.wrapper.setProps({ snapshot: snap("Renamed by someone else") });

    expect(t.shown()).toBe("South Sister Summit");
  });

  // The other half of the contract: a name arriving for a field nobody is in still
  // has to land. Guarding on focus buys the cases above; it must not cost this one.
  it("still takes a new name when the field is not focused", async () => {
    const t = open("Eagle Creek");
    await t.wrapper.setProps({ snapshot: snap("Renamed elsewhere") });
    expect(t.shown()).toBe("Renamed elsewhere");
  });

  // Leaving hands control back, rather than pinning the box to whatever it held.
  it("resumes tracking the snapshot once you leave", async () => {
    const t = open("Eagle Creek");
    await t.field.trigger("focus");
    await t.type("Wonderland");
    await t.commit();

    await t.wrapper.setProps({ snapshot: snap("Ozette Loop") });
    expect(t.shown()).toBe("Ozette Loop");
  });

  // The tidy has to stay visible. The reducer curls apostrophes on the way in and the
  // box has to show what got SAVED — including when the tidied value equals what's
  // already stored, where nothing reactive fires to do it for us.
  it("shows the stored spelling back after committing", async () => {
    const t = open("Ryan’s Timberline");
    await t.field.trigger("focus");
    await t.type("Ryan's Timberline"); // straight apostrophe — tidies to the stored one
    await t.commit();

    expect(setMeta).toHaveBeenCalledWith({ title: "Ryan's Timberline" });
    expect(t.shown()).toBe("Ryan’s Timberline");
  });
});
