import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { PWA_OPTIONS } from "../config/pwa";
import { applyOps, type Op } from "../shared/ops";
import { stubCacheStorage } from "./helpers/cacheStorage";
import { blankState, folder, item } from "./helpers/list";

const rules = PWA_OPTIONS.workbox?.runtimeCaching ?? [];
type Match = (o: { request: { mode: string }; url: URL }) => boolean;
const nav = (path: string, mode = "navigate") => ({
  request: { mode },
  url: new URL(path, "https://mahonia.app"),
});
const shell = rules.find(
  (r) => typeof r.urlPattern === "function" && (r.urlPattern as unknown as Match)(nav("/e/abc123")),
);
const matches = (path: string, mode?: string) => (shell?.urlPattern as unknown as Match)(nav(path, mode));

describe("the app shell offline", () => {
  it("precaches the client-only shell, stamped per build like /", () => {
    const urls = (PWA_OPTIONS.workbox?.additionalManifestEntries ?? []).map((e) =>
      typeof e === "string" ? e : e.url,
    );
    expect(urls).toEqual(expect.arrayContaining(["/", "/_shell"]));
  });

  // A runtime-cached copy of an /e page names the chunks of the build it came from,
  // which the next deploy's worker deletes — so the page itself must never be served
  // from cache, only the precached shell that matches the live chunks.
  it("serves every edit link from the network, falling back to the precached shell", () => {
    expect(shell?.handler).toBe("NetworkOnly");
    expect(shell?.options?.precacheFallback).toEqual({ fallbackURL: "/_shell" });
    expect(shell?.options?.cacheName).toBeUndefined();
    for (const path of ["/e", "/e/", "/e/abc123"]) expect(matches(path)).toBe(true);
  });

  // An installed app reopens wherever it was left, and My Gear is the page you'd want
  // offline after a list; the static pages ride along because their payloads are
  // already precached.
  it("gives the app's other pages the same fallback", () => {
    for (const path of ["/gear", "/gear/", "/account", "/help", "/about", "/legal"]) {
      expect(matches(path)).toBe(true);
    }
  });

  it("answers only page navigations, never data or a page that needs the network", () => {
    expect(matches("/e/abc123", "cors")).toBe(false);
    expect(matches("/gear", "cors")).toBe(false);
    expect(matches("/s/T1MBER11NE00", "cors")).toBe(false);
    for (const path of [
      "/e/_payload.json/x",
      "/api/l/e",
      "/api/s/e",
      "/api/s/T1MBER11NE00",
      "/api/vault/list",
      "/l/e",
      "/e/a/b",
      "/gear/x",
      "/help/_payload.json",
      "/authorize",
      "/auth/callback",
      "/gearbox",
    ]) {
      expect(matches(path)).toBe(false);
    }
  });
});

// A share link opens offline from the same shell. Its list arrives inside the page's
// HTML, which the worker must not keep (the reason above), so the page keeps the list
// itself and reads it back (tests/sharedListOffline.nuxt.test.ts).
describe("the shared read view offline", () => {
  it("opens a share link from the shell", () => {
    for (const path of ["/s/T1MBER11NE00", "/s/t1mber11ne00", "/s/T1MBER11NE00/"]) {
      expect(matches(path), path).toBe(true);
    }
  });

  it("but not its Markdown twin, the bare /s, or anything under a code", () => {
    for (const path of ["/s/T1MBER11NE00.md", "/s", "/s/", "/s/T1MBER11NE00/x", "/og/s/T1MBER11NE00"]) {
      expect(matches(path), path).toBe(false);
    }
  });

  it("keeps no copy of a list in the worker, as a page or as data", () => {
    const keeping = rules.filter((r) => r.handler !== "NetworkOnly" || r.options?.cacheName);
    expect(keeping.map((r) => String(r.urlPattern))).toEqual([]);
  });
});

// The worker before this one kept share pages and their data in two caches of its own.
// The scripts the config has the worker import are run here as the worker runs them,
// then told the worker has activated.
describe("the caches the worker used to keep", () => {
  it("are deleted when the worker activates, with their record of ages, and nothing else is", async () => {
    const kept = stubCacheStorage();
    onTestFinished(() => void vi.unstubAllGlobals());
    for (const name of ["mahonia-list-data", "mahonia-list-pages", "mahonia-shared-lists", "workbox-precache-v2-https://mahonia.app/"]) {
      await (await caches.open(name)).put("/s/T1MBER11NE00", new Response("kept"));
    }
    const listeners: Record<string, ((event: { waitUntil: (work: Promise<unknown>) => void }) => void)[]> = {};
    const deleteDatabase = vi.fn();
    const scope = { addEventListener: (type: string, fn: (typeof listeners)[string][number]) => (listeners[type] ??= []).push(fn) };
    for (const script of PWA_OPTIONS.workbox?.importScripts ?? []) {
      runInNewContext(readFileSync(resolve(__dirname, "../public", `.${script}`), "utf8"), { self: scope, caches, indexedDB: { deleteDatabase } });
    }

    // loading the script deletes nothing: the worker that serves from them may still be the one in control
    expect([...kept.keys()]).toHaveLength(4);
    expect(Object.keys(listeners)).toEqual(["activate"]);
    const work: Promise<unknown>[] = [];
    for (const fn of listeners.activate!) fn({ waitUntil: (p) => void work.push(p) });
    expect(work).toHaveLength(1);
    await Promise.all(work);

    // the page's own copy of a share link and the precache stay
    expect([...kept.keys()]).toEqual(["mahonia-shared-lists", "workbox-precache-v2-https://mahonia.app/"]);
    expect(deleteDatabase.mock.calls).toEqual([["workbox-expiration"]]);
  });
});

// The installed app's identity and its long-press menu. The manifest is hand-written
// JSON (pwa.manifest is false), so nothing else would notice a shortcut pointing at a
// page the worker can't open offline.
describe("the web app manifest", () => {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, "../public/manifest.webmanifest"), "utf8")) as {
    id?: string;
    start_url?: string;
    shortcuts?: { name: string; url: string }[];
  };

  it("pins its identity to the start address, so an install already made keeps it", () => {
    expect(manifest.id).toBe("/");
    expect(manifest.start_url).toBe("/");
  });

  it("offers New list and My Gear, both pages that open offline", () => {
    expect(manifest.shortcuts?.map((s) => s.url)).toEqual(["/e", "/gear"]);
    for (const s of manifest.shortcuts ?? []) expect(matches(s.url)).toBe(true);
  });
});

// vite-pwa sets these for "autoUpdate" only when it injects the registration, and
// this app registers by hand. An update must wait for every open page to close
// (activating it deletes their chunks); a first visit is claimed at once.
describe("service worker updates", () => {
  it("wait for open pages to close, and claim a first visit", () => {
    expect(PWA_OPTIONS.injectRegister).toBe(false);
    expect(PWA_OPTIONS.workbox?.skipWaiting).toBe(false);
    expect(PWA_OPTIONS.workbox?.clientsClaim).toBe(true);
  });
});

// The editor keeps what the server hasn't acknowledged and sends it again itself
// (useGearList). The worker held a second copy of each failed send until 2026-11 and
// replayed it whenever the browser next woke it, which could be after the editor's own
// retry and after newer edits.
describe("unsent edits have one queue, the editor's", () => {
  it("no rule has the worker queue a write and replay it later", () => {
    expect(rules.filter((r) => r.options?.backgroundSync).map((r) => String(r.urlPattern))).toEqual([]);
  });

  it("because a batch that arrives a second time, late, undoes the edits made since", () => {
    const failedSend: Op[] = [{ t: "updateItem", id: "i1", patch: { unitWeightMg: 500_000 } }];
    const s = blankState({ folders: [folder()], items: [item({ id: "i1", name: "Tent" })] });
    applyOps(s, failedSend); // the editor's own retry lands
    applyOps(s, [{ t: "updateItem", id: "i1", patch: { unitWeightMg: 538_000 } }]); // then a correction
    applyOps(s, failedSend); // then the worker's copy of the first send
    expect(s.items[0]?.unitWeightMg).toBe(500_000);
  });
});
