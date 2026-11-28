// The "Import a list" dialog while a request is out. The file button and Cancel stay
// live beside it, and an import mints a list and navigates, so a second one started on
// top of the first made two lists, and Cancel left the import running and took you to its
// result anyway. Nothing recalls a request already sent; what's pinned here is what
// happens to the steps after it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { readBody } from "h3";
import ImportModal from "~/components/ImportModal.vue";
import { snapshotFor } from "./helpers/list";
import { listToMarkdown } from "~~/shared/exporters/markdown";

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  vaultKnown: ref(true),
  vaultFetch: () => Promise.resolve({}),
}));

const CSV = "Item Name,Weight\nDuplex,510\n";
const LINK = "https://lighterpack.com/r/abc123";

function gate() {
  let open!: () => void;
  const held = new Promise<void>((r) => (open = r));
  return { held, open };
}

let creates = 0;
let createGate: ReturnType<typeof gate> | null = null;
let importGate = gate();
let failCreate = false;

let createdBodies: { data?: { items?: Record<string, unknown>[] } }[] = [];
let matchReply: unknown[] = [];

registerEndpoint("/api/lists/create", {
  method: "POST",
  handler: async (event) => {
    createdBodies.push(await readBody(event));
    creates++;
    const n = creates;
    if (createGate) await createGate.held;
    if (failCreate) throw new Error("no");
    return { editToken: `token-${n}`, snapshot: snapshotFor({ shareCode: `TESTC0DE000${n}`, slug: "s", title: "t" }) };
  },
});
registerEndpoint("/api/catalog/match", { method: "POST", handler: () => ({ matches: matchReply }) });
registerEndpoint("/api/s/SHARED000001", () => ({
  snapshot: snapshotFor({
    shareCode: "SHARED000001",
    slug: "s",
    title: "Timberline",
    folders: [{ id: "f", name: "Shelter", colorKey: "green", defaultClassification: "base", sortOrder: 0 }],
    items: [{ id: "i", folderId: "f", name: "Tiger Wall UL2", brand: "Big Agnes", qty: 1, sortOrder: 0, unitWeightMg: 992000, classification: null }],
  }),
}));
registerEndpoint("/api/import", {
  method: "POST",
  handler: async () => {
    await importGate.held;
    return {
      data: {
        folders: [{ id: "f", name: "Shelter", sortOrder: 0 }],
        items: [{ id: "i", folderId: "f", name: "Tent", qty: 1, sortOrder: 0, unitWeightMg: 1, classification: "base" }],
      },
    };
  },
});

enableAutoUnmount(afterEach);

function dialog() {
  return mount(ImportModal, {
    props: { open: true },
    global: { stubs: { BaseModal: { template: "<div><slot /></div>" } } },
  });
}
type Dialog = ReturnType<typeof dialog>;

const submit = async (w: Dialog, text: string) => {
  await w.get("textarea").setValue(text);
  await w.get("button.btn--primary").trigger("click");
};
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("importing a list", () => {
  let push: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    creates = 0;
    createGate = null;
    importGate = gate();
    failCreate = false;
    createdBodies = [];
    matchReply = [];
    push = vi.spyOn(useRouter(), "push").mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("makes the list, closes and goes to it", async () => {
    const w = dialog();
    await submit(w, CSV);
    await vi.waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(creates).toBe(1);
    expect(w.emitted("close")).toHaveLength(1);
  });

  // A row recognised as catalog food, in a folder that is already food, stores no class
  // of its own, as the editor's pick stores it, so it follows the folder if moved.
  // Our own plain-text copy ends "…full list at https://mahonia.app/s/CODE". Read as
  // text, its one line of names made one item; the link names the whole list.
  it("brings in the list a pasted Mahonia link names, whole, not the text around it", async () => {
    const w = dialog();
    await submit(w, "Big Agnes Tiger Wall UL2 tent, Zenbivy Quilt, Nemo Tensor\n\nBase weight 2.2 lb, 4 lb total — full list at https://mahonia.app/s/shared000001");
    await settle();
    expect(creates).toBe(1);
    const body = createdBodies[0] as { title?: string; data: { items: { name: string; brand?: string; unitWeightMg: number }[] } };
    expect(body.title).toBe("Timberline");
    expect(body.data.items.map((i) => [i.brand, i.name, i.unitWeightMg])).toEqual([["Big Agnes", "Tiger Wall UL2", 992000]]);
    expect(push).toHaveBeenCalledTimes(1);
  });

  // A table is read as pasted, link or not: our Markdown copy ends with its link too,
  // and following it fetched the live list instead, dropping any edit made to the text
  // and failing offline or once the list was gone.
  it("reads a pasted Markdown copy as the table it holds, though it ends with its link", async () => {
    const md = listToMarkdown(
      snapshotFor({
        shareCode: "SHARED000001",
        slug: "s",
        title: "Edited copy",
        folders: [{ id: "f", name: "Shelter", colorKey: "green", defaultClassification: "base", sortOrder: 0 }],
        items: [{ id: "i", folderId: "f", name: "Duplex", qty: 1, sortOrder: 0, unitWeightMg: 510_000, classification: null }],
      }),
    );
    expect(md).toContain("mahonia.app/s/SHARED000001");
    const w = dialog();
    await submit(w, md);
    await settle();
    expect(createdBodies[0]!.data!.items!.map((i) => i.name)).toEqual(["Duplex"]);
  });

  it("reads a pasted CSV as the CSV, though a cell holds a Mahonia link", async () => {
    const w = dialog();
    await submit(w, "Item Name,Weight,URL\nDuplex,510,https://mahonia.app/s/SHARED000001\n");
    await settle();
    expect(createdBodies[0]!.data!.items!.map((i) => i.name)).toEqual(["Duplex"]);
    expect(createdBodies[0]!.data).not.toHaveProperty("typed");
  });

  it("links catalog food in a food folder without pinning its class", async () => {
    matchReply = [{ id: 4, brand: "Clif", name: "Builders Bar", variant: null, weightMg: 68_000, weightSource: "manufacturer", verified: true, commonName: "Energy bar", categoryHint: "consumable", kcal: 290 }];
    const backup = JSON.stringify({
      folders: [{ id: "f", name: "Food", colorKey: "food", defaultClassification: "consumable", sortOrder: 0 }],
      items: [{ id: "i", folderId: "f", name: "Clif Builders Bar", qty: 1, sortOrder: 0, unitWeightMg: 0, classification: null }],
    });
    const w = dialog();
    await submit(w, backup);
    await vi.waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(createdBodies[0]!.data!.items![0]).toMatchObject({ catalogItemId: 4, unitWeightMg: 68_000, classification: null });
  });

  it("makes one list when a file is chosen during a request", async () => {
    createGate = gate();
    const w = dialog();
    await submit(w, CSV);
    await vi.waitFor(() => expect(creates).toBe(1));

    w.findComponent({ name: "FilePickButton" }).vm.$emit("text", CSV, new File([CSV], "gear.csv"));
    createGate.open();
    await vi.waitFor(() => expect(push).toHaveBeenCalledOnce());
    await settle();
    expect(creates).toBe(1);
  });

  it("makes nothing when Cancel is pressed during a LighterPack fetch", async () => {
    const w = dialog();
    await submit(w, LINK);
    await w.setProps({ open: false });
    importGate.open();
    await settle();
    expect(creates).toBe(0);
    expect(push).not.toHaveBeenCalled();
  });

  it("stays where you are when Cancel is pressed after the create went out", async () => {
    createGate = gate();
    const w = dialog();
    await submit(w, CSV);
    await vi.waitFor(() => expect(creates).toBe(1));
    await w.setProps({ open: false });
    createGate.open();
    await settle();
    expect(push).not.toHaveBeenCalled();
    expect(w.emitted("close")).toBeUndefined();
  });

  it("lets a reopened dialog run its own import, and only that one lands", async () => {
    const w = dialog();
    await submit(w, LINK);
    await w.setProps({ open: false });
    await w.setProps({ open: true });

    await submit(w, CSV);
    await vi.waitFor(() => expect(push).toHaveBeenCalledOnce());
    importGate.open();
    await settle();
    expect(creates).toBe(1);
    expect(push).toHaveBeenCalledOnce();
  });

  it("leaves a reopened form usable when an earlier fetch lands in it", async () => {
    const w = dialog();
    await submit(w, LINK);
    await w.setProps({ open: false });
    await w.setProps({ open: true });
    await w.get("textarea").setValue(CSV);

    importGate.open();
    await settle();
    expect(w.get("button.btn--primary").text()).toBe("Import");
    expect(w.get("button.btn--primary").attributes("disabled")).toBeUndefined();
  });

  it("keeps a late failure out of the form that replaced it", async () => {
    failCreate = true;
    createGate = gate();
    const w = dialog();
    await submit(w, CSV);
    await vi.waitFor(() => expect(creates).toBe(1));
    await w.setProps({ open: false });
    await w.setProps({ open: true });

    createGate.open();
    await settle();
    expect(w.text()).not.toContain("Import failed.");
  });

  it("takes a retry after a refusal", async () => {
    failCreate = true;
    const w = dialog();
    await submit(w, CSV);
    await vi.waitFor(() => expect(w.text()).toContain("Import failed."));

    failCreate = false;
    await w.get("button.btn--primary").trigger("click");
    await vi.waitFor(() => expect(push).toHaveBeenCalledOnce());
  });
});

// The words point at what the editor shows. A backup's row there is "JSON" on the
// Sharing panel's Export tab; "Download JSON" is a label only the read view's and My
// Gear's menus show, and the dialog sent people looking for it.
describe("where the import dialog says a backup comes from", () => {
  it("names the Export tab in its hint and in both refusals, and never Download JSON", async () => {
    const w = dialog();
    expect(w.findComponent({ name: "Tooltip" }).props("text")).toContain(
      "A file can also be a JSON backup from the Export tab in Sharing.",
    );

    await submit(w, '{"not":"a list"}');
    expect(w.get(".import__err").text()).toBe(
      "That looks like JSON, but not a list backup. Make one from the Export tab in Sharing.",
    );

    const text = '{"not":"a list"}';
    w.findComponent({ name: "FilePickButton" }).vm.$emit("text", text, new File([text], "pack.json"));
    await nextTick();
    expect(w.get(".import__err").text()).toBe(
      "Couldn’t read that file as a list backup. Make one from the Export tab in Sharing.",
    );
    expect(w.text()).not.toContain("Download JSON");
  });

  // The account export holds every list. It isn't one, so it can't become one, but
  // "not a list backup" told someone holding the file their lists came from that it
  // was nothing of ours.
  it("says what an account export is, pasted or chosen", async () => {
    const w = dialog();
    const takeout = JSON.stringify({ format: "mahonia-account-export", version: 1, exportedAt: "x", lists: [{}, {}], gear: { items: [] } });
    const said = "That’s an account export, with 2 lists in it. A list comes back from its own JSON; My Gear’s import reads the gear in this file.";
    await submit(w, takeout);
    expect(w.get(".import__err").text()).toBe(said);
    w.findComponent({ name: "FilePickButton" }).vm.$emit("text", takeout, new File([takeout], "mahonia-export.json"));
    await nextTick();
    expect(w.get(".import__err").text()).toBe(said);
  });

  it("names the paste box for a screen reader, not by its placeholder alone", () => {
    expect(dialog().get("textarea").attributes("aria-label")).toBe("LighterPack link or CSV");
  });
});

// "Choose a file…" is the other way to put something in, so it stands with the paste box.
// It was the first of three in the action row, a bare phrase beside the contained Cancel
// and Import, and on a phone the row wrapped and left Import alone on a second line.
// A link or a CSV is already on the clipboard, so the dialog opens with the caret in
// the box it goes in. The shell here drops its contents while closed, as BaseModal does
// (the box is a new node on every open, which is what the focus follows).
describe("where the import dialog opens", () => {
  it("puts the caret in the paste box, on the first open and on a reopen", async () => {
    const w = mount(ImportModal, {
      props: { open: true },
      attachTo: document.body,
      global: { stubs: { BaseModal: { props: ["open"], template: `<div v-if="open"><slot /></div>` } } },
    });
    await nextTick();
    expect(document.activeElement).toBe(w.get("textarea").element);

    await w.setProps({ open: false });
    await w.setProps({ open: true });
    await nextTick();
    expect(document.activeElement).toBe(w.get("textarea").element);
  });
});

describe("the import dialog's buttons", () => {
  it("keeps the action row to Cancel and Import", () => {
    const w = dialog();
    expect(w.findAll(".dlg__actions button").map((b) => b.text())).toEqual(["Cancel", "Import"]);
  });

  it("sets Choose a file under the paste box, contained", () => {
    const w = dialog();
    const pick = w.get("button.filepick");
    expect(pick.classes()).toEqual(expect.arrayContaining(["btn", "btn--soft"]));
    expect(pick.element.closest(".dlg__actions")).toBeNull();
    expect(w.get("textarea").element.compareDocumentPosition(pick.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // The CSV's columns and the other file it takes were four lines of grey type under the
  // button, the longest thing on the card. They are behind a (?) beside the button, the
  // way the header's "Import map file" says which map files it reads.
  it("keeps the formats behind a question mark beside Choose a file", () => {
    const w = dialog();
    const row = w.get(".import__pick");
    expect(row.find("button.filepick").exists()).toBe(true);
    const why = row.get("button.import__why");
    expect(why.attributes("aria-label")).toBe("Which files and columns can be imported");
    expect(w.findComponent({ name: "Tooltip" }).props("text")).toContain(
      "A CSV’s header row names its columns: Category, Item Name, Qty, Weight, Unit, Worn, Consumable. Without one, each line is an item.",
    );
    // nothing left on the card spells the columns out
    expect(w.text()).not.toContain("header row");
  });

  // Bare, the name's placeholder was a grey phrase adrift between the lede and the paste
  // box. It is a field, so it is drawn as one, in the box's own tint, and the inputs sit
  // one distance apart: neither the name nor the hint adds a margin of its own.
  it("draws the list name as a field, one gap from the paste box", () => {
    const w = dialog();
    const name = w.get('input[aria-label="List name"]');
    expect(name.classes()).toEqual(expect.arrayContaining(["field", "well"]));
    // named for what it is, in the editor's own words for its title field
    expect(name.attributes("placeholder")).toBe("List name");
    expect(name.element.nextElementSibling?.tagName).toBe("TEXTAREA");
  });
});

