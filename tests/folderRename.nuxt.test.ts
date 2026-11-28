// A folder's name field, committed. The reducer ignores a rename to nothing and stores a
// rename to the same name unchanged, but an op that reaches the queue is still sent, and
// the server saves the list and moves its version for it. So the header decides: only a
// name the folder doesn't already have is an edit.
//
// The real header on the real controller, read at the wire: the ops in the one batch
// that follows are everything the header queued.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage } from "./helpers/storage";
import { snapshotFor } from "./helpers/list";
import { memoryListStore, quietVaultAccess } from "./helpers/gearList";
import { openList, registerEditorEndpoints } from "./helpers/controller";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { readBody } from "h3";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import FolderSection from "~/components/FolderSection.vue";
import { _setFlushDebounce } from "~/composables/useGearList";
import type { Op } from "~~/shared/ops";

mockNuxtImport("useVaultAccess", () => () => quietVaultAccess());
mockNuxtImport("useLocalListStore", () => () => memoryListStore());

stubLocalStorage();

registerEditorEndpoints();
let sent: Op[][] = [];
registerEndpoint("/api/edit/mutate", {
  method: "POST",
  handler: async (event) => {
    sent.push((await readBody<{ ops: Op[] }>(event)).ops);
    return { ok: true };
  },
});

const open = () =>
  openList(
    snapshotFor({
      shareCode: "F0LDERNAME01",
      slug: "folder-name-aaa",
      folders: [{ id: "f1", name: "Ryan’s shelter", colorKey: "green", defaultClassification: "base", sortOrder: 0 }],
    }),
    "folder-name-edit-token",
  );

/** The real header over the live controller's snapshot, and its name field. */
function mountHeader(c: ReturnType<typeof useGearList>) {
  const w = mount(FolderSection, {
    props: {
      get list() {
        return c.snapshot.value!;
      },
      get folder() {
        return c.snapshot.value!.folders[0]!;
      },
      items: [],
    },
    global: { stubs: { FolderRows: true } },
  });
  const field = w.get<HTMLInputElement>('input[aria-label="Folder name"]');
  /** Type over the name and leave the field, as a person does (setValue fires the change). */
  const rename = (typed: string) => field.setValue(typed);
  return { field, rename };
}

beforeEach(() => {
  sent = [];
  _setFlushDebounce(0);
});
enableAutoUnmount(afterEach);
afterEach(() => {
  useGearList().dispose();
  _setFlushDebounce();
});

describe("renaming a folder from its header", () => {
  it("queues nothing for a name cleared, or typed again as it is, and puts the name back in the box", async () => {
    const c = await open();
    const { field, rename } = mountHeader(c);

    for (const typed of ["", "   ", "Ryan’s shelter", "  Ryan's shelter "]) {
      await rename(typed);
      expect(field.element.value, JSON.stringify(typed)).toBe("Ryan’s shelter");
    }
    expect(c.snapshot.value!.folders[0]!.name).toBe("Ryan’s shelter");

    // a real rename still goes, and it is all that goes
    await rename("Ryan's tent");
    expect(field.element.value).toBe("Ryan’s tent");
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5_000, interval: 25 });
    expect(sent[0]).toEqual([{ t: "updateFolder", id: "f1", patch: { name: "Ryan's tent" } }]);
  });
});
