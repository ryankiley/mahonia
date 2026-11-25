// npm run catalog:format — rewrite every seed/_research/*.json in the house layout
// (formatResearchFile). Values never change: the file is parsed and written back, a
// `_note` read as the `_comment` it always meant.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESEARCH_DIR } from "./paths";
import { formatResearchFile } from "./research";

let changed = 0;
for (const file of readdirSync(RESEARCH_DIR).filter((f) => f.endsWith(".json")).sort()) {
  const path = join(RESEARCH_DIR, file);
  const raw = readFileSync(path, "utf8");
  const { _note, _comment, ...rest } = JSON.parse(raw) as { _note?: unknown; _comment?: unknown; rows: unknown[] };
  const text = formatResearchFile({ _comment: _comment ?? _note, ...rest });
  if (text !== raw) {
    writeFileSync(path, text);
    changed++;
  }
}
console.log(`✓ ${changed} research file(s) rewritten in the house layout`);
