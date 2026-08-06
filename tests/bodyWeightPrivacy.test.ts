import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listToJson } from "../shared/exporters/json";
import type { ListMeta, ListData } from "../shared/types";

// Body weight is the most personal thing this app has ever been told, and it is now the
// one thing it deliberately refuses to store.
//
// It used to be a column on `lists`, kept off read paths by an opt-in wrapper that every
// new read path had to remember to call. That shape failed the way opt-in shapes fail:
// three separate OWNER paths forgot the wrapper, and because the field is optional they
// all type-checked and shipped — one of them emptying the field on every autosave.
//
// So it moved to the device (app/composables/useBodyWeight.ts). There is no column, no
// op, no field on ListMeta, and no server file that has ever heard of it. The guarantee
// is no longer "we strip it on the way out" but "there is no way in" — which is not a
// promise about behaviour, it's a fact about what the code can do.
//
// These tests defend an ABSENCE, because an absence is exactly the kind of guarantee that
// erodes the first time someone adds a convenient column.

const ROOT = new URL("..", import.meta.url).pathname;

/** Every source file under a directory, minus build output. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === "node_modules" || name === ".nuxt" || name === ".output" || name === "dist") continue;
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) sources(rel, out);
    else if (/\.(ts|vue)$/.test(name)) out.push(rel);
  }
  return out;
}

/** Comments may discuss it; code may not carry it. */
const withoutComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/<!--[\s\S]*?-->/g, "");

describe("body weight never reaches the server", () => {
  it("appears nowhere in server/", () => {
    // The strongest form of the guarantee: not "it is stripped" but "there is nothing to
    // strip". A new column, an endpoint field, or a helpful passthrough all fail here.
    const offenders = sources("server").filter((f) =>
      /bodyWeight|body_weight/i.test(withoutComments(readFileSync(join(ROOT, f), "utf8"))),
    );
    expect(offenders).toEqual([]);
  });

  it("is not a field on the list's shared types, reducer, or snapshot chain", () => {
    // These are the wire. A field here would ride an op to the server whether or not a
    // column existed to receive it.
    for (const f of ["shared/types.ts", "shared/ops.ts", "shared/snapshotDiff.ts", "shared/clone.ts"]) {
      const code = withoutComments(readFileSync(join(ROOT, f), "utf8"));
      expect(code, `${f} must not carry body weight`).not.toMatch(/bodyWeight/);
    }
  });

  it("stays out of a JSON backup", () => {
    // A backup is a file people mail to each other. listToJson builds by destructuring
    // named fields, so this also catches the field being reintroduced upstream.
    const list = {
      title: "Trip",
      displayUnit: "g",
      bodyWeightG: 82_000,
      folders: [],
      items: [],
      days: [],
    } as unknown as ListMeta & ListData;
    const json = listToJson(list);
    expect(json).not.toContain("bodyWeight");
    expect(json).not.toContain("82000");
  });

  it("is described accurately where a reader will actually look", () => {
    // The privacy page makes a claim about this in prose. If the storage location changes
    // again, that paragraph becomes wrong and someone has to be made to notice.
    const legal = withoutComments(readFileSync(join(ROOT, "app/pages/legal.vue"), "utf8"));
    expect(legal).toMatch(/body weight/i);
    expect(legal).toMatch(/device|browser/i);
  });
});
