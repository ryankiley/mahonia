// Write the rows an admin verified in the app (verify_catalog_item) back out as research,
// so the audit checks them and the next reseed takes them over: id kept, verified_by
// cleared, the seed's from then on. Optional and by hand, before a research PR:
//   DATABASE_URL=$(cat .data/prod-db-url) npm run catalog:graduate
// It only reads the database (one SELECT) and writes seed/_research/verified-in-app.json,
// merged with what that file already holds; then catalog:build and catalog:audit as for
// any research. A measured row with no citation URL can't be research (the audit needs a
// URL on every row), so it is listed and stays in the database, where its stamp keeps it.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { useDb } from "../server/utils/db";
import { asResearchRow, GRADUATE_FILE, inAppVerified, mergeResearch } from "./graduate";
import type { ResearchRow } from "./research";

async function main() {
  const rows = await inAppVerified(await useDb());
  const research = rows.map(asResearchRow);
  const kept = rows.filter((_, i) => !research[i]);
  const existing: ResearchRow[] = existsSync(GRADUATE_FILE) ? (JSON.parse(readFileSync(GRADUATE_FILE, "utf8")).rows ?? []) : [];
  const merged = mergeResearch(existing, research.filter((r): r is ResearchRow => r !== null));
  writeFileSync(
    GRADUATE_FILE,
    `${JSON.stringify({ _comment: "Rows verified in the app (verify_catalog_item), written out by npm run catalog:graduate.", rows: merged }, null, 2)}\n`,
  );
  console.log(`${rows.length - kept.length} in-app verified rows written to seed/_research/verified-in-app.json (${merged.length} rows in the file).`);
  for (const r of kept) console.log(`  kept in the database, no citation URL: row ${r.id}, ${[r.brand, r.name, r.variant].filter(Boolean).join(" ")}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("Graduate failed:", e);
    process.exit(1);
  },
);
