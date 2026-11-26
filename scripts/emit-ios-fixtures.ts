// Writes the iOS port's golden fixtures (scripts/iosFixtures.ts has the scenarios
// and the reasoning).
//
//   npm run ios:fixtures            → writes .data/ios-fixtures/*.json
//   npm run ios:fixtures -- <dir>   → writes there instead (the iOS repo's
//                                     Tests/MahoniaCoreTests/Fixtures)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, exportVectors, fixtures, glyphVectors } from "./iosFixtures";

const outDir = process.argv[2] ?? ".data/ios-fixtures";
const vectorDir = join(outDir, "vectors");

mkdirSync(vectorDir, { recursive: true });
for (const f of fixtures) {
  writeFileSync(join(outDir, `${f.name}.json`), canonical(f) + "\n");
}
writeFileSync(join(vectorDir, "exports.json"), canonical({ cases: exportVectors }) + "\n");
writeFileSync(join(vectorDir, "gear-glyphs.json"), canonical(glyphVectors()) + "\n");
console.log(`wrote ${fixtures.length} fixtures and 2 vector files to ${outDir}`);
