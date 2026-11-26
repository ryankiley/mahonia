import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { writtenByAnotherPostgres } from "../server/utils/db";

// A local database folder from another Postgres major won't open, and PGlite's own
// words for it name neither the folder nor the reason. These pin the sentence the
// dev server says instead, and that it is said only when the majors really differ.

const dirs: string[] = [];
const folder = (pgVersion?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "mahonia-pg-"));
  dirs.push(dir);
  if (pgVersion !== undefined) writeFileSync(join(dir, "PG_VERSION"), `${pgVersion}\n`);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const running = (version: string) => async () => ({
  query: async () => ({ rows: [{ server_version: version }] }),
  close: async () => {},
});

describe("a local database folder from another Postgres", () => {
  it("names the folder, both versions and the way out", async () => {
    const dir = folder("18");
    const error = await writtenByAnotherPostgres(dir, running("19.0"));
    expect(error?.message).toContain(dir);
    expect(error?.message).toContain("written by PostgreSQL 18");
    expect(error?.message).toContain("runs PostgreSQL 19");
    expect(error?.message).toContain("npm run seed");
  });

  it("leaves the folder as it found it", async () => {
    const dir = folder("18");
    await writtenByAnotherPostgres(dir, running("19.0"));
    expect(readFileSync(join(dir, "PG_VERSION"), "utf8")).toBe("18\n");
  });

  it("says nothing when the folder is this Postgres's own", async () => {
    expect(await writtenByAnotherPostgres(folder("19"), running("19.0"))).toBeUndefined();
  });

  it("says nothing about a folder with no version in it, and never boots the probe", async () => {
    let booted = false;
    const probe = async () => {
      booted = true;
      return running("19.0")();
    };
    expect(await writtenByAnotherPostgres(folder(), probe)).toBeUndefined();
    expect(booted).toBe(false);
  });

  it("reads the installed PGlite's own version", async () => {
    const error = await writtenByAnotherPostgres(folder("1"), () => PGlite.create());
    expect(error?.message).toMatch(/runs PostgreSQL \d+,/);
  });
});
