// A share link with no connection. The page is server-rendered with its list inside the
// HTML, so the browser never asks for the list and the service worker never sees it:
// offline, its fallback shell had nothing to show and would have said the list doesn't
// exist. The page keeps the list it was given on the device and reads it back when the
// server can't be reached; the worker only supplies the shell (config/pwa.ts).
//
// Mounted here the way the shell mounts it: in the browser, with no server payload, so
// the page asks for the list itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, mountSuspended, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { createError } from "h3";
import { createFetch } from "ofetch";
import ListSharePage from "~/pages/s/[code].vue";
import { keepSharedList, readSharedList } from "~/utils/sharedListCopy";
import type { ListSnapshot } from "~~/shared/types";
import { stubCacheStorage } from "./helpers/cacheStorage";
import { blankList, item } from "./helpers/list";

const OPENED = "T1MBER11NE00";
const NEVER = "NEVER0PENED0";
const GONE = "G0NE00000000";
const BROKEN = "BR0KEN000000";

const list = (shareCode: string, title = "Timberline"): ListSnapshot =>
  blankList({
    shareCode,
    title,
    updatedAt: "2026-07-01T12:00:00.000Z",
    items: [item({ id: "i1", name: "Duplex", unitWeightMg: 539_000 })],
  });

// what the server says, per test
const served = { title: "Timberline" };
registerEndpoint(`/api/s/${OPENED}`, () => ({ snapshot: list(OPENED, served.title) }));
registerEndpoint(`/api/s/${NEVER}`, () => ({ snapshot: list(NEVER, "Wonderland") }));
registerEndpoint(`/api/s/${GONE}`, () => {
  throw createError({ statusCode: 404 });
});
registerEndpoint(`/api/s/${BROKEN}`, () => {
  throw createError({ statusCode: 503 });
});

// The connection. Off, every request fails the way a browser's does with no network: no
// response at all, so the error ofetch throws carries no status either. The page asks
// through useRequestFetch, which in the browser is the app's own $fetch.
const link = { up: true };
const unreachable = createFetch({ fetch: () => Promise.reject(new TypeError("Failed to fetch")) });
mockNuxtImport("useRequestFetch", () => () => (url: string) => (link.up ? globalThis.$fetch(url) : unreachable(url)));

const offlineMode = { on: true };
mockNuxtImport("useOfflineEnabled", () => () => offlineMode.on);

enableAutoUnmount(afterEach);

let kept: ReturnType<typeof stubCacheStorage>;
const copyOf = (code: string) => kept.get("mahonia-shared-lists")?.get(`/api/s/${code}`);

beforeEach(() => {
  kept = stubCacheStorage();
  link.up = true;
  offlineMode.on = true;
  served.title = "Timberline";
});

const open = (code: string) => mountSuspended(ListSharePage, { route: `/s/${code}` });
/** the quiet line under the title that says the list is a copy, when there is one */
const keptLine = (page: Awaited<ReturnType<typeof open>>) =>
  page
    .findAll(".view__meta")
    .map((line) => line.text())
    .find((text) => text.startsWith("Offline"));
const DAY = 24 * 60 * 60 * 1000;

describe("a share link opened with a connection", () => {
  it("shows the list with no word about copies, and keeps the server's answer as it came", async () => {
    const page = await open(OPENED);
    expect(page.get("h1").text()).toBe("Timberline");
    expect(page.text()).not.toContain("Offline");
    await vi.waitFor(() => expect(copyOf(OPENED)).toBeDefined());
    // the answer /api/s gave, whole and nothing else
    expect(await copyOf(OPENED)!.clone().json()).toEqual({ snapshot: list(OPENED) });
  });

  it("keeps nothing where the offline shell is switched off, since nothing could open it", async () => {
    offlineMode.on = false;
    const page = await open(OPENED);
    expect(page.get("h1").text()).toBe("Timberline");
    await flushPromises();
    await new Promise((r) => setTimeout(r, 50));
    expect(copyOf(OPENED)).toBeUndefined();
  });
});

describe("a share link opened with no connection", () => {
  it("shows the list as this device last saw it", async () => {
    const online = await open(OPENED);
    await vi.waitFor(() => expect(copyOf(OPENED)).toBeDefined());
    online.unmount();

    link.up = false;
    const page = await open(OPENED);
    expect(page.get("h1").text()).toBe("Timberline");
    expect(page.text()).toContain("Duplex");
    expect(keptLine(page)).toBe("Offline · saved on this device just now");
  });

  it("says when the copy is from", async () => {
    await keepSharedList(list(OPENED), Date.now() - 3 * DAY);
    link.up = false;
    const page = await open(OPENED);
    expect(keptLine(page)).toBe("Offline · saved on this device 3 days ago");
  });

  it("says it can't be loaded when this device never opened it, not that it doesn't exist", async () => {
    link.up = false;
    const page = await open(NEVER);
    expect(page.find("h1").exists()).toBe(false);
    expect(page.text()).toContain(
      "You’re offline, and this list isn’t saved on this device. It opens once you’re back online.",
    );
    expect(page.text()).not.toContain("doesn’t exist");
  });

  it("opens the list by itself once the connection is back", async () => {
    link.up = false;
    const page = await open(NEVER);
    expect(page.text()).toContain("isn’t saved on this device");

    link.up = true;
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(page.find("h1").exists()).toBe(true));
    expect(page.get("h1").text()).toBe("Wonderland");
    expect(page.text()).not.toContain("Offline");
  });

  it("trades the copy for the list as it is now, once the connection is back", async () => {
    await keepSharedList(list(OPENED), Date.now() - 3 * DAY);
    link.up = false;
    const page = await open(OPENED);
    expect(keptLine(page)).toBeDefined();

    served.title = "Timberline, the long way";
    link.up = true;
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(page.get("h1").text()).toBe("Timberline, the long way"));
    expect(keptLine(page)).toBeUndefined();
    // and the copy is the new answer
    await vi.waitFor(async () =>
      expect((await readSharedList(OPENED))?.snapshot.title).toBe("Timberline, the long way"),
    );
  });
});

describe("a list the server says is gone", () => {
  it("reads as gone, and the copy this device kept goes with it", async () => {
    await keepSharedList(list(GONE));
    expect(copyOf(GONE)).toBeDefined();

    const page = await open(GONE);
    expect(page.text()).toContain("This list doesn’t exist, or was deleted.");
    expect(page.find("h1").exists()).toBe(false);
    await vi.waitFor(() => expect(copyOf(GONE)).toBeUndefined());
  });

  it("is dropped when the list goes while its copy is on screen", async () => {
    await keepSharedList(list(GONE));
    link.up = false;
    const page = await open(GONE);
    expect(page.get("h1").text()).toBe("Timberline");

    link.up = true;
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(page.text()).toContain("This list doesn’t exist, or was deleted."));
    await vi.waitFor(() => expect(copyOf(GONE)).toBeUndefined());
  });
});

describe("a server that fails", () => {
  it("is not a list that is gone: the page says it couldn't be loaded", async () => {
    const page = await open(BROKEN);
    expect(page.text()).toContain("This list couldn’t be loaded. Check your connection and try again.");
    expect(page.text()).not.toContain("doesn’t exist");
  });

  it("leaves the copy alone, and shows it", async () => {
    await keepSharedList(list(BROKEN, "Enchantments"), Date.now() - DAY);
    const page = await open(BROKEN);
    expect(page.get("h1").text()).toBe("Enchantments");
    expect(keptLine(page)).toBe("Offline · saved on this device yesterday");
    expect(copyOf(BROKEN)).toBeDefined();
  });
});

describe("the copies a device keeps", () => {
  const code = (n: number) => `C0PY${String(n).padStart(8, "0")}`;

  it("are the fifty opened most recently", async () => {
    for (let n = 0; n < 50; n++) await keepSharedList(list(code(n)));
    // the oldest is opened again, so it is the newest
    await keepSharedList(list(code(0)));
    await keepSharedList(list(code(50)));
    expect(kept.get("mahonia-shared-lists")!.size).toBe(50);
    expect(await readSharedList(code(1))).toBeNull();
    expect((await readSharedList(code(0)))?.snapshot.shareCode).toBe(code(0));
    expect((await readSharedList(code(50)))?.snapshot.shareCode).toBe(code(50));
  });

  it("are found however the code in the address was typed", async () => {
    await keepSharedList(list(OPENED), 1_764_000_000_000);
    expect(await readSharedList(OPENED.toLowerCase())).toEqual({ snapshot: list(OPENED), keptAt: 1_764_000_000_000 });
  });

  it("read as nothing when the entry isn't a dated list", async () => {
    const dated = { headers: { date: new Date().toUTCString() } };
    const entries = new Map<string, Response>();
    kept.set("mahonia-shared-lists", entries);
    for (const entry of [
      new Response("<html>", dated),
      new Response(JSON.stringify({ error: true }), dated),
      new Response(JSON.stringify({ snapshot: list(OPENED) })),
    ]) {
      entries.set(`/api/s/${OPENED}`, entry);
      expect(await readSharedList(OPENED)).toBeNull();
    }
  });

  it("are not kept or read where the browser has no Cache Storage", async () => {
    vi.stubGlobal("caches", undefined);
    await expect(keepSharedList(list(OPENED))).resolves.toBeUndefined();
    expect(await readSharedList(OPENED)).toBeNull();
  });
});
