// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { useGearTypes } from "~/composables/useGearTypes";
import ItemRow from "~/components/ItemRow.vue";
import { blankList } from "./helpers/list";
import { gearListStub } from "./helpers/gearList";
import { rowProvides } from "./helpers/itemRow";
import type { ListSnapshot } from "~~/shared/types";

const snapshot = ref<ListSnapshot>(blankList());
mockNuxtImport("useGearList", () => () => gearListStub({ snapshot }));
const fetchTypes = vi.fn();
registerEndpoint("/api/catalog/types", () => fetchTypes());
const wrappers: ReturnType<typeof mount>[] = [];

beforeEach(() => {
  fetchTypes.mockReset().mockResolvedValue(["PLB", "Tent", "Trail runners"]);
  snapshot.value = blankList();
});
afterEach(() => {
  wrappers.splice(0).forEach(w => w.unmount());
});

describe("gear-type suggestions", () => {
  it("waits for focus, then loads once and reuses the vocabulary across rows", async () => {
    const { names, load } = useGearTypes();
    await flushPromises();
    expect(fetchTypes).not.toHaveBeenCalled();
    expect(names.value).toBeNull();
    await load();
    expect(fetchTypes).toHaveBeenCalledTimes(1);
    expect(names.value).toEqual(["PLB", "Tent", "Trail runners"]);
    await load();
    expect(fetchTypes).toHaveBeenCalledTimes(1);
  });

  it("does not start a second request while the first is pending", async () => {
    let finish!: (value: string[]) => void;
    fetchTypes.mockImplementation(() => new Promise<string[]>(resolve => { finish = resolve; }));
    const { names, load } = useGearTypes();
    const pending = load();
    await load();
    await vi.waitFor(() => expect(fetchTypes).toHaveBeenCalledTimes(1));
    finish(["Tent"]);
    await pending;
    expect(names.value).toEqual(["Tent"]);
  });

  it("keeps an unavailable vocabulary optional and retries on a later focus", async () => {
    fetchTypes.mockRejectedValueOnce(new Error("Offline"));
    const { names, load } = useGearTypes();
    await load();
    expect(names.value).toBeNull();
    await load();
    expect(fetchTypes).toHaveBeenCalledTimes(2);
    expect(names.value).toHaveLength(3);
  });

  it("accepts an empty catalog without refetching on every focus", async () => {
    fetchTypes.mockResolvedValue([]);
    const { names, load } = useGearTypes();
    await load();
    await load();
    expect(fetchTypes).toHaveBeenCalledTimes(1);
    expect(names.value).toEqual([]);
  });

  it("leaves existing gear types alone and still commits custom text or an empty value", async () => {
    snapshot.value.items = [{ id: "typed", name: "My shelter", commonName: "Custom shelter", qty: 1,
      unitWeightMg: 500_000, folderId: "f1", classification: null, sortOrder: 0 }];
    const w = mount(ItemRow, {
      props: { get list() { return snapshot.value; }, get item() { return snapshot.value.items[0]!; } },
      global: { provide: rowProvides() },
    });
    wrappers.push(w);
    await useGearTypes().load();
    const field = w.get<HTMLInputElement>('input[aria-label="Gear type"]');
    expect(field.attributes("list")).toBe("gear-types");
    expect(field.element.value).toBe("Custom shelter");
    expect(snapshot.value.items[0]!.commonNameOverridden).toBeUndefined();
    await field.setValue("Hand-sewn tarp");
    expect(snapshot.value.items[0]!.commonName).toBe("Hand-sewn tarp");
    expect(snapshot.value.items[0]!.commonNameOverridden).toBe(true);
    await field.setValue("");
    expect(snapshot.value.items[0]!.commonName).toBeUndefined();
  });
});
