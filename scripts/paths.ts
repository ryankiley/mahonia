// The catalog pipeline's fixed inputs, named once. The builder, the auditor, the
// seeder and the gating test each derived the repo root and respelled these
// paths — five chances for a move or rename to miss one (the same drift class
// the reseed workflow's path filter guards against).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CATALOG_CSV = join(ROOT, "seed", "catalog.csv");
export const RESEARCH_DIR = join(ROOT, "seed", "_research");
export const COMMON_NAMES_JSON = join(ROOT, "seed", "common-names.json");
