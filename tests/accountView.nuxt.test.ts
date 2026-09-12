// @vitest-environment nuxt
//
// AccountView stays mounted through a forced session refresh. That is useful for
// the account modal, but it means an old account's promise can settle after a new
// account occupies the same component. These tests deliberately replace A with B
// without unmounting so every request must prove it still owns its result.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, defineComponent, nextTick, reactive, ref } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import type { PasskeySummary } from "~~/shared/types";
import AccountView from "~/components/AccountView.vue";

const download = vi.hoisted(() => ({ file: vi.fn() }));
vi.mock("~/utils/download", () => ({ downloadFile: download.file }));

type User = { email: string; displayName: string | null };
const user = ref<User | null>({ email: "a@example.com", displayName: "Ada" });
const signedIn = computed(() => user.value !== null);
const presence = computed(() => signedIn.value ? "signedIn" : "signedOut");
const loaded = ref(true);
const accountGeneration = ref(0);
const refresh = vi.fn(async () => {});
const signOut = vi.fn(async () => {});
const saveProfile = vi.fn(async () => true);
const requestLink = vi.fn(async () => "sent");
const forgetAccountMemos = vi.fn();

mockNuxtImport("useSession", () => () => ({
  user,
  signedIn,
  presence,
  loaded,
  accountGeneration,
  refresh,
  requestLink,
  signOut,
  saveProfile,
  forgetAccountMemos,
}));

const confirmState = reactive({ checked: false });
const confirm = vi.fn();
mockNuxtImport("useDialogs", () => () => ({ confirm, confirmState }));

const passkeyList = vi.fn();
const passkeyRegister = vi.fn();
const passkeyRemove = vi.fn();
mockNuxtImport("usePasskeys", () => () => ({
  list: passkeyList,
  register: passkeyRegister,
  remove: passkeyRemove,
  signIn: vi.fn(),
  signUp: vi.fn(),
}));
mockNuxtImport("passkeysSupported", () => () => true);
mockNuxtImport("useReturnTo", () => () => ({ resume: vi.fn() }));
mockNuxtImport("tally", () => vi.fn());

const ClientOnlyStub = defineComponent({ template: "<div><slot /></div>" });
const HugeiconsStub = defineComponent({ template: "<i />" });
let wrapper: ReturnType<typeof mount> | undefined;

let exportCalls = 0;
let signOutAllCalls = 0;
let deleteCalls = 0;
let deferExport = false;
let exportPayload: { lists: unknown[]; gear: { items: unknown[] } } = { lists: [], gear: { items: [] } };
let settleExports: Array<() => void> = [];
registerEndpoint("/api/account/export", async () => {
  exportCalls++;
  const response = exportPayload;
  if (deferExport) await new Promise<void>((resolve) => settleExports.push(resolve));
  return response;
});
registerEndpoint("/api/auth/signout-all", {
  method: "POST",
  handler: () => {
    signOutAllCalls++;
    return { ok: true };
  },
});
registerEndpoint("/api/account/delete", {
  method: "POST",
  handler: () => {
    deleteCalls++;
    return { listsDeleted: 0 };
  },
});

const key = (id: number, label: string): PasskeySummary => ({
  id,
  label,
  createdAt: "2026-09-12T00:00:00.000Z",
  lastUsedAt: null,
});

function open() {
  wrapper = mount(AccountView, {
    attachTo: document.body,
    global: { stubs: { ClientOnly: ClientOnlyStub, HugeiconsIcon: HugeiconsStub } },
  });
  return wrapper;
}

function button(text: string) {
  const found = wrapper!.findAll("button").find((candidate) => candidate.text().trim() === text);
  expect(found, `missing ${text} button`).toBeTruthy();
  return found!;
}

async function settle() {
  await flushPromises();
  await nextTick();
}

function becomeB() {
  user.value = { email: "b@example.com", displayName: "Bea" };
  accountGeneration.value++;
}

beforeEach(() => {
  user.value = { email: "a@example.com", displayName: "Ada" };
  loaded.value = true;
  accountGeneration.value = 0;
  confirmState.checked = false;
  refresh.mockClear();
  signOut.mockClear();
  saveProfile.mockReset();
  saveProfile.mockResolvedValue(true);
  requestLink.mockClear();
  forgetAccountMemos.mockClear();
  confirm.mockReset();
  passkeyList.mockReset();
  passkeyList.mockResolvedValue([]);
  passkeyRegister.mockReset();
  passkeyRemove.mockReset();
  download.file.mockReset();
  exportCalls = 0;
  signOutAllCalls = 0;
  deleteCalls = 0;
  deferExport = false;
  exportPayload = { lists: [], gear: { items: [] } };
  settleExports = [];
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = "";
  for (const settleExport of settleExports) settleExport();
  settleExports = [];
});

describe("AccountView account lifetime", () => {
  it("does not let A's late passkey list overwrite B's keys", async () => {
    let finishA!: (rows: PasskeySummary[]) => void;
    passkeyList
      .mockImplementationOnce(() => new Promise<PasskeySummary[]>((resolve) => (finishA = resolve)))
      .mockResolvedValueOnce([key(2, "B key")]);
    open();
    await vi.waitFor(() => expect(passkeyList).toHaveBeenCalledTimes(1));

    becomeB();
    await vi.waitFor(() => expect(passkeyList).toHaveBeenCalledTimes(2));
    await settle();
    expect(wrapper!.text()).toContain("B key");

    finishA([key(1, "A key")]);
    await settle();
    expect(wrapper!.text()).toContain("B key");
    expect(wrapper!.text()).not.toContain("A key");
  });

  it("clears a stale profile save rather than showing it to B", async () => {
    let finish!: (ok: boolean) => void;
    saveProfile.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finish = resolve)));
    open();
    await settle();

    const field = wrapper!.get('input[aria-label="Display name"]');
    await field.setValue("Ada revised");
    await button("Save").trigger("submit");
    expect(wrapper!.text()).toContain("Saving…");

    becomeB();
    await settle();
    finish(true);
    await settle();
    expect((field.element as HTMLInputElement).value).toBe("Bea");
    expect(wrapper!.text()).not.toContain("Saved. Lists you make now carry your name.");
    expect(wrapper!.text()).not.toContain("Saving…");
  });

  it("does not download A's export after B replaces the session", async () => {
    deferExport = true;
    exportPayload = { lists: [{ title: "A list" }], gear: { items: [{}] } };
    open();
    await settle();

    await button("Download everything").trigger("click");
    await vi.waitFor(() => expect(exportCalls).toBe(1));
    becomeB();
    settleExports[0]!();
    await settle();

    expect(download.file).not.toHaveBeenCalled();
    expect(wrapper!.text()).not.toContain("Saved 1 list and 1 piece of gear.");
  });

  it.each(["Remove", "Sign out everywhere", "Delete account"])("does not execute %s after its A confirmation belongs to B", async (label) => {
    let answer!: (value: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answer = resolve)));
    passkeyList.mockResolvedValue([key(1, "A key")]);
    open();
    await settle();

    await button(label).trigger("click");
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    becomeB();
    answer(true);
    await settle();

    if (label === "Remove") expect(passkeyRemove).not.toHaveBeenCalled();
    if (label === "Sign out everywhere") expect(signOutAllCalls).toBe(0);
    if (label === "Delete account") expect(deleteCalls).toBe(0);
  });

  it("clears an A passkey ceremony instead of leaving B busy or successful", async () => {
    let finish!: (result: "ok") => void;
    passkeyRegister.mockImplementationOnce(() => new Promise<"ok">((resolve) => (finish = resolve)));
    open();
    await settle();

    await button("Add").trigger("click");
    expect(wrapper!.text()).toContain("Passkeys");
    becomeB();
    finish("ok");
    await settle();

    expect(wrapper!.text()).not.toContain("Added. You can sign in with it from now on.");
    expect(button("Add").attributes("disabled")).toBeUndefined();
  });
});
