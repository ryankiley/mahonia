// npm run catalog:format — rewrite every seed/_research/*.json in the house layout
// (formatResearchFile). Values never change: the file is parsed and written back, a
// `_note` read as the `_comment` it always meant (researchFileNote).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESEARCH_DIR } from "./paths";
import { formatResearchFile, researchFileNames } from "./research";

let changed = 0;
for (const file of researchFileNames(RESEARCH_DIR)) {
  const path = join(RESEARCH_DIR, file);
  const raw = readFileSync(path, "utf8");
  const text = formatResearchFile(JSON.parse(raw) as { rows: unknown[] });
  if (text !== raw) {
    writeFileSync(path, text);
    changed++;
  }
}
console.log(`✓ ${changed} research file(s) rewritten in the house layout`);
