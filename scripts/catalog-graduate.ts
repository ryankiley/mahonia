// Write the rows an admin verified in the app (verify_catalog_item) back out as research,
// so the audit checks them and the next reseed takes them over: id kept, verified_by
// cleared, the seed's from then on. Optional and by hand, before a research PR:
//   DATABASE_URL=$(cat .data/prod-db-url) npm run catalog:graduate
// It only reads the database (one SELECT) and writes research files. A row the research
// already has (a research row whose weight was corrected from the maker's page) is written
// back into that row of its own file, its other keys kept; every other row is merged into
// seed/_research/verified-in-app.json. A file it writes is written whole in the house
// layout (catalog:format), which every research file is already held to, so only the rows
// that changed differ. Then catalog:build and catalog:audit as for any research. Until the
// research agrees with such a row, the reseed leaves it as it is (upsertSeedRows). A
// measured row with no citation URL can't be research (the audit needs a URL on every
// row), so it is listed and stays in the database, where its stamp keeps it.
//
// Every row written back into its own file is listed with what the research said and what
// the app holds. One whose research changed after the verification (the row keeps what the
// research said when the seed last wrote it) is marked: graduating throws that research
// change away, so it wants a look before the PR merges.
// .github/workflows/graduate-catalog.yml runs this weekly and puts the output in the PR it
// opens.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useDb } from "../server/utils/db";
import { SEP } from "./catalogCsv";
import { asResearchRow, type Cited, inAppVerified, planGraduation, researchWhenVerified } from "./graduate";
import { RESEARCH_DIR } from "./paths";
import { GRADUATED_FILE_NAME, researchFileNames, type ResearchRow } from "./research";

async function main() {
  const db = await useDb();
  const rows = await inAppVerified(db);
  const research = rows.map(asResearchRow);
  const kept = rows.filter((_, i) => !research[i]);
  // every research file, verified-in-app.json among them: planGraduation tells them apart
  const files = researchFileNames(RESEARCH_DIR).map((file) => ({ file, raw: readFileSync(join(RESEARCH_DIR, file), "utf8") }));
  const plan = planGraduation(research.filter((r): r is ResearchRow => r !== null), files, researchWhenVerified(rows));
  for (const [file, text] of plan.writes) writeFileSync(join(RESEARCH_DIR, file), text);

  const back = [...plan.inPlace.values()].reduce((a, b) => a + b, 0);
  const where = [...plan.inPlace].map(([file, n]) => `${file}: ${n}`).join(", ");
  console.log(`${back} in-app verified rows written back into their own research files${back ? ` (${where})` : ""}.`);
  console.log(`${plan.toGraduated} in-app verified rows written to seed/_research/${GRADUATED_FILE_NAME}.`);
  const show = (c: Cited) => `${c.weightMg == null ? "?" : c.weightMg / 1000} g, ${c.sourceUrl ?? "no link"}`;
  for (const o of plan.overwrites) {
    const name = o.key.split(SEP).filter(Boolean).join(" ");
    console.log(`  ${o.researchMoved ? "⚠ " : ""}${o.file}: ${name}: research ${show(o.research)} → app ${show(o.app)}`);
    if (o.researchMoved && o.whenVerified)
      console.log(`    the research changed after this was verified in the app (it said ${show(o.whenVerified)} then); graduating replaces that change`);
  }
  const moved = plan.overwrites.filter((o) => o.researchMoved).length;
  if (moved) console.log(`${moved} research rows marked ⚠ changed after their verification: check each before merging.`);
  for (const r of kept) console.log(`  kept in the database, no citation URL: row ${r.id}, ${[r.brand, r.name, r.variant].filter(Boolean).join(" ")}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("Graduate failed:", e);
    process.exit(1);
  },
);
