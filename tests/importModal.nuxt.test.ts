// The "Import a list" dialog while a request is out. The file button and Cancel stay
// live beside it, and an import mints a list and navigates, so a second one started on
// top of the first made two lists, and Cancel left the import running and took you to its
// result anyway. Nothing recalls a request already sent; what's pinned here is what
// happens to the steps after it.
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
