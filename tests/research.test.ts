import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCommonNames, readResearchFiles } from "../scripts/research";

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
      "bad-scalar.json": '{"rows": [{"name": 42}, {"name": "Pack"}, {"kcal": "250"}]}',
      "broken.json": '{"rows": [',
      "valid.json": '{"rows": [{"name": "Pack"}]}',
    });

    const files = readResearchFiles(dir);
    expect(files.map(({ file, rows, parseError }) => ({ file, rows, parseError }))).toEqual([
      { file: "array.json", rows: [], parseError: 'expected an object with a "rows" array' },
      { file: "bad-row.json", rows: [], parseError: "row 1 must be an object" },
      // every bad row named at once, and the good one between them held back with them
      { file: "bad-scalar.json", rows: [], parseError: "row 1 has a non-text name; row 3 has a non-numeric kcal" },
      { file: "broken.json", rows: [], parseError: expect.stringMatching(/^invalid JSON: /) },
      { file: "rows-object.json", rows: [], parseError: 'expected "rows" to be an array' },
      { file: "valid.json", rows: [{ name: "Pack" }], parseError: undefined },
    ]);
  });

  it("only treats a missing common-name map as empty", () => {
    const dir = fixture({
      "bad.json": "[",
      "not-array.json": "{}",
      "bad-entry.json": '[{"common_name": 42}]',
      "empty-common-with-bad-identity.json": '[{"brand": 42, "common_name": ""}]',
      "valid.json": '[{"brand": "Acme", "name": "Pack", "variant": "M", "common_name": "Backpack"}]',
    });

    expect(loadCommonNames(join(dir, "missing.json"))).toEqual(new Map());
    expect(() => loadCommonNames(join(dir, "bad.json"))).toThrow("Couldn't read common-name map");
    expect(() => loadCommonNames(join(dir, "not-array.json"))).toThrow("must be a JSON array");
    expect(() => loadCommonNames(join(dir, "bad-entry.json"))).toThrow("non-text common_name");
    expect(() => loadCommonNames(join(dir, "empty-common-with-bad-identity.json"))).toThrow("non-text brand");
    // the identity is keyed the way the build keys it: a letter size spells out
    expect(loadCommonNames(join(dir, "valid.json"))).toEqual(new Map([["acme|pack|medium", "Backpack"]]));
  });

  it("rejects duplicate identities after the build's variant normalization", () => {
    const dir = fixture({
      "duplicate.json": JSON.stringify([
        { brand: "Acme", name: "Pack", variant: "M", common_name: "backpack" },
        { brand: "acme", name: "pack", variant: "Medium", common_name: "daypack" },
      ]),
    });

    expect(() => loadCommonNames(join(dir, "duplicate.json"))).toThrow(
      "entry 2 duplicates entry 1 for acme|pack|medium",
    );
  });
});
