// The "Import a list" dialog while a request is out. The file button and Cancel stay
// live beside it, and an import mints a list and navigates, so a second one started on
// top of the first made two lists, and Cancel left the import running and took you to its
// result anyway. Nothing recalls a request already sent; what's pinned here is what
// happens to the steps after it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import ImportModal from "~/components/ImportModal.vue";
import { snapshotFor } from "./helpers/list";

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

registerEndpoint("/api/lists/create", {
  method: "POST",
  handler: async () => {
    creates++;
    const n = creates;
    if (createGate) await createGate.held;
    if (failCreate) throw new Error("no");
    return { editToken: `token-${n}`, snapshot: snapshotFor({ shareCode: `TESTC0DE000${n}`, slug: "s", title: "t" }) };
  },
});
registerEndpoint("/api/catalog/match", { method: "POST", handler: () => ({ matches: [] }) });
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

  it("names the paste box for a screen reader, not by its placeholder alone", () => {
    expect(dialog().get("textarea").attributes("aria-label")).toBe("LighterPack link or CSV");
  });
});

// "Choose a file…" is the other way to put something in, so it stands with the paste box.
// It was the first of three in the action row, a bare phrase beside the contained Cancel
// and Import, and on a phone the row wrapped and left Import alone on a second line.
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
    expect(w.find(".import__hint").exists()).toBe(false);
    const row = w.get(".import__pick");
    expect(row.find("button.filepick").exists()).toBe(true);
    const why = row.get("button.import__why");
    expect(why.attributes("aria-label")).toBe("Which files and columns can be imported");
    // the icon scale's full step: the small one was a speck beside a 40px button
    expect(readFileSync(resolve(__dirname, "../app/components/ImportModal.vue"), "utf8")).toContain(
      '<SvgIcon :icon="IconQuestionmarkCircle" aria-hidden="true" />',
    );
    expect(w.findComponent({ name: "Tooltip" }).props("text")).toContain(
      "A CSV needs a header row: Category, Item Name, Qty, Weight, Unit, Worn, Consumable.",
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
    const source = readFileSync(resolve(__dirname, "../app/components/ImportModal.vue"), "utf8");
    const styles = source.slice(source.indexOf("<style"));
    expect(styles).not.toMatch(/margin-(top|bottom): var\(--space-2\)/);
  });
});

