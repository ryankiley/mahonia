import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PWA_OPTIONS, pwaPrecacheRevision } from "../config/pwa";

describe("pwaPrecacheRevision", () => {
  it("uses a unique Vercel deployment ID ahead of the commit SHA", () => {
    expect(
      pwaPrecacheRevision(
        { VERCEL_DEPLOYMENT_ID: "dpl_second", VERCEL_GIT_COMMIT_SHA: "same-commit" },
        "local-build",
      ),
    ).toBe("dpl_second");
  });

  it("falls back to the commit SHA, then a local-build revision", () => {
    expect(pwaPrecacheRevision({ VERCEL_GIT_COMMIT_SHA: "commit" }, "local-build")).toBe("commit");
    expect(pwaPrecacheRevision({}, "local-build")).toBe("local-build");
  });
});

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

  it("answers only page navigations, never data or pages with rules of their own", () => {
    expect(matches("/e/abc123", "cors")).toBe(false);
    expect(matches("/gear", "cors")).toBe(false);
    for (const path of [
      "/e/_payload.json/x",
      "/api/l/e",
      "/api/s/e",
      "/api/vault/list",
      "/l/e",
      "/s/abc123",
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
