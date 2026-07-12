#!/usr/bin/env node
// Point git at the repo's committed hooks (.githooks/) so they're live on every
// clone straight from `npm install` — no separate install step, no hook manager
// dependency. Silently a no-op outside a git checkout (npm tarballs, some CIs).
import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
} catch {
  // not a git checkout — nothing to wire
}
