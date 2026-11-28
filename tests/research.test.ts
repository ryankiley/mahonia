import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatResearchFile, readResearchFiles } from "../scripts/research";

const tempDirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mahonia-research-"));
  tempDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("research file boundaries", () => {
  it("reports a non-object root or non-array rows as a file error, not an empty catalog", () => {
    const dir = fixture({
      "array.json": "[]",
      "rows-object.json": '{"rows": {}}',
      "bad-row.json": '{"rows": [null]}',
      "bad-scalar.json": '{"rows": [{"name": 42}, {"name": "Pack"}, {"kcal": "250"}, {"quote_unchecked": true}]}',
      "broken.json": '{"rows": [',
      "valid.json": '{"rows": [{"name": "Pack"}]}',
    });

    const files = readResearchFiles(dir);
    expect(files.map(({ file, rows, parseError }) => ({ file, rows, parseError }))).toEqual([
      { file: "array.json", rows: [], parseError: 'expected an object with a "rows" array' },
      { file: "bad-row.json", rows: [], parseError: "row 1 must be an object" },
      // every bad row named at once, and the good one between them held back with them
      { file: "bad-scalar.json", rows: [], parseError: "row 1 has a non-text name; row 3 has a non-numeric kcal; row 4 has a non-text quote_unchecked" },
      { file: "broken.json", rows: [], parseError: expect.stringMatching(/^invalid JSON: /) },
      { file: "rows-object.json", rows: [], parseError: 'expected "rows" to be an array' },
      { file: "valid.json", rows: [{ name: "Pack" }], parseError: undefined },
    ]);
  });

  it("writes quote_unchecked beside the quote it excuses, and leaves it out when empty", () => {
    const row = { kcal: 250, quote_unchecked: "community estimate, no maker figure", quote: "~10oz", name: "Bar" };
    expect(formatResearchFile({ rows: [row] })).toBe(
      '{\n  "rows": [\n    {\n      "name": "Bar",\n      "quote": "~10oz",\n      "quote_unchecked": "community estimate, no maker figure",\n      "kcal": 250\n    }\n  ]\n}\n',
    );
    expect(formatResearchFile({ rows: [{ ...row, quote_unchecked: "" }] })).not.toContain("quote_unchecked");
  });
});
