// Shared reader for the cited research JSON in seed/_research/*.json — used by both
// build-catalog.ts (emits the CSV) and audit-catalog.ts (accuracy gate). The row
// SHAPE and the read-every-file-and-parse loop were duplicated across the two; the
// per-row VALIDATION is intentionally different and stays in each script.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One row of cited research exactly as authored. Superset shape — each script
 *  validates only the fields it needs. `category_hint` is `string | null` (the
 *  wider of the two former local copies). */
export interface ResearchRow {
  brand?: string | null;
  name?: string;
  variant?: string | null;
  category_hint?: string | null;
  weight_value?: number;
  weight_unit?: string;
  weight_secondary?: string | null;
  weight_source?: string;
  source_url?: string | null;
  quote?: string;
}

/** A parsed research file, or a parse error for it. Rows are `[]` when `parseError`
 *  is set — the CALLER decides how to bucket it (build → skipped/exit 0; audit →
 *  errors/exit 1), so the reader never swallows or logs the failure itself. */
export interface ResearchFile {
  file: string;
  rows: ResearchRow[];
  parseError?: string;
}

/** Read + JSON-parse every `*.json` under `researchDir`, sorted by filename. Never
 *  throws: a file that won't parse comes back with `parseError` set and `rows: []`. */
export function readResearchFiles(researchDir: string): ResearchFile[] {
  const files = readdirSync(researchDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((file) => {
    try {
      const parsed = JSON.parse(readFileSync(join(researchDir, file), "utf8")) as {
        rows?: ResearchRow[];
      };
      return { file, rows: parsed.rows ?? [] };
    } catch (e) {
      return { file, rows: [], parseError: (e as Error).message };
    }
  });
}
