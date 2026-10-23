#!/usr/bin/env node
// Does the SERVER bundle still render an OG card? Run after `nuxt build`.
//
// Nothing else asks. The tests import satori from node_modules, where every
// dependency is whole; typecheck never looks at a build; the bundle budget reads
// only .output/public. What this guards has bitten twice, each time with every
// gate green and production broken. satori 0.33's harfbuzz glue read its wasm off
// disk by a path node-file-trace could not follow, so the deployed bundle shipped
// hb.js without hb.wasm and the instance aborted on its first render (#296 — fixed
// then by a nitro hook that copied the file by hand, retired once satori embedded
// both wasms). And satori 0.35.2–0.37.0 read `__dirname` at import time, which does
// not exist in an ES module, so the og chunk threw the moment it loaded (#441).
//
// So: import the og chunk out of .output/server the way nitro will, and draw one
// glyph with the satori that bundle resolves, with a real font — the layout and
// shaping wasms both have to be found and run for a <path> to come out. Importing
// a nitro chunk boots the server (the chunk graph reaches the entry), so the port
// is an ephemeral one and the process exits by hand.

import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

process.env.NITRO_PORT = "0";
const root = resolve(import.meta.dirname, "..");
const server = resolve(root, ".output/server");
const href = (p) => pathToFileURL(resolve(server, p)).href;

setTimeout(() => {
  console.error("✗ server bundle probe timed out");
  process.exit(2);
}, 60_000);

// shared/ogCard.ts (the model) and server/utils/ogCard.ts (the renderer) both
// build to an ogCard chunk; the renderer is the one that imports satori.
const named = await Array.fromAsync(glob("chunks/**/ogCard*.mjs", { cwd: server }));
const chunks = [];
for (const c of named) if (/from ['"]satori['"]/.test(await readFile(resolve(server, c), "utf8"))) chunks.push(c);
if (chunks.length !== 1) throw new Error(`expected one og chunk importing satori under .output/server/chunks, found ${chunks.length} of ${named.join(", ") || "none"}`);
const og = await import(href(chunks[0]));
if (!Object.keys(og).length) throw new Error(`${chunks[0]} exported nothing`);

const { default: satori } = await import(href("node_modules/satori/dist/index.js"));
const data = await readFile(resolve(root, "server/assets/fonts/inter-regular.ttf"));
const svg = await satori(
  { type: "div", props: { style: { display: "flex", fontSize: 40 }, children: "x" }, key: null },
  { width: 100, height: 60, fonts: [{ name: "Inter", data, weight: 400, style: "normal" }] },
);
if (!svg.includes("<path")) throw new Error("the bundled satori drew no glyph");

console.log(`✓ server bundle renders — ${chunks[0]} imports, and satori drew a glyph (${svg.length} B of SVG)`);
process.exit(0);
