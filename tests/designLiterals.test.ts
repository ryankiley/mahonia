import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blank, ROOT, stripComments, walkSources } from "./helpers/sources";

// NO RAW LITERAL WHERE A TOKEN SCALE EXISTS.
//
// designTokens.test.ts proves that every var(--x) names something. This is its other
// half: that a value which HAS a scale is taken from it. An audit on 2026-11-27 found
// colour, font size, motion and the layer order already there — one stray in ~5,000
// lines of stylesheet — and found line-height not: twenty raw leadings beside two tokens
// whose comment said they were the only two in use. Nothing had been keeping the clean
// ones clean but care, and care is what let the leadings drift.
//
// So each rule below pins a class of value where it stands today. What a rule lets
// through, it names (ALLOWED), with the reason, and an entry that stops matching
// anything fails the run: a list of exceptions that outlives its exceptions is how a
// check like this gets ignored.
//
// Deliberately NOT here: spacing, sizes and radii. Those are full of honest literals — an
// optical nudge in em, a measure in ch, a hit area — and a rule that has to allow sixty
// things teaches people to add the sixty-first. The token file is exempt throughout: it
// is where the literals are supposed to be.

const TOKENS = "app/assets/styles/foundations/tokens.scss";

interface Decl {
  file: string;
  line: number;
  prop: string;
  value: string;
}

/** Every `prop: value` in the style layer: the .scss files whole, and the <style>
 *  blocks of the components. Comments are blanked first — this codebase quotes the
 *  values it removed in the comment that removed them. */
function declarations(): Decl[] {
  const out: Decl[] = [];
  for (const path of walkSources(["app"], ["scss", "vue"])) {
    const file = path.slice(ROOT.length);
    if (file === TOKENS) continue;
    let src = readFileSync(path, "utf8");
    if (path.endsWith(".vue")) {
      // keep the <style> blocks where they are, so line numbers stay true
      const styles = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)];
      let kept = blank(src);
      for (const m of styles) {
        const at = m.index + m[0].indexOf(m[1]!);
        kept = kept.slice(0, at) + m[1]! + kept.slice(at + m[1]!.length);
      }
      src = kept;
    }
    src = stripComments(src);
    // a declaration starts after `;`, `{` or `}` and ends at `;` or `}`. A selector
    // with a pseudo-class (`a:hover {`) ends at `{`, so it is never mistaken for one.
    for (const m of src.matchAll(/(?<=^|[;{}])(\s*)([a-z-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/g)) {
      const line = src.slice(0, m.index + m[1]!.length).split("\n").length;
      out.push({ file, line, prop: m[2]!, value: m[3]!.replace(/\s+/g, " ") });
    }
  }
  return out;
}

const decls = declarations();

/** The declared value of every token whose name starts with `prefix`, from the token file. */
function tokenValues(prefix: string): Map<string, string> {
  const src = stripComments(readFileSync(ROOT + TOKENS, "utf8"));
  const out = new Map<string, string>();
  for (const m of src.matchAll(new RegExp(`(${prefix}[a-z0-9-]*)\\s*:\\s*([^;]+);`, "g"))) out.set(m[1]!, m[2]!.trim());
  return out;
}

interface Allowed {
  file: string;
  prop: string;
  value: string;
  why: string;
}

/** Run one rule: the declarations it rejects, less the ones it names. Returns what is
 *  left to fix, and the exceptions nothing matched any more. */
function check(offends: (d: Decl) => boolean, allowed: Allowed[]) {
  const used = new Set<Allowed>();
  const found = decls.filter(offends).filter((d) => {
    const a = allowed.find((x) => x.file === d.file && x.prop === d.prop && x.value === d.value);
    if (a) used.add(a);
    return !a;
  });
  return {
    found: found.map((d) => `${d.file}:${d.line}  ${d.prop}: ${d.value}`),
    stale: allowed.filter((a) => !used.has(a)).map((a) => `${a.file}  ${a.prop}: ${a.value}`),
  };
}

const COLOUR =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|(?<![-\w$.#])(?:black|white|red|green|blue|gr[ae]y|yellow|orange|pink|purple)(?![-\w(])/i;

describe("design literals", () => {
  it("colour comes from a token", () => {
    const { found, stale } = check(
      // a mask is alpha, whatever it is written in; `content` is text
      (d) => !/^(?:-webkit-)?mask(?:-image)?$|^content$/.test(d.prop) && COLOUR.test(d.value),
      [],
    );
    expect(found).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("font-size comes from the type scale", () => {
    const { found, stale } = check(
      (d) => (d.prop === "font-size" || d.prop === "font") && !/var\(--text-[a-z-]+\)|^inherit$/.test(d.value),
      [
        {
          file: "app/components/AccountMenu.vue",
          prop: "font-size",
          value: "calc(var(--avatar) * 0.64)",
          why: "the initial is a fraction of its disc, so the two grow together",
        },
        {
          file: "app/components/RouteMap.client.vue",
          prop: "font-size",
          value: "calc(10 * var(--tpx))",
          why: "the map's attribution: a licence line, legible and under every step of the scale",
        },
      ],
    );
    expect(found).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("line-height uses the token when a token holds that value", () => {
    const leadings = new Set(tokenValues("--leading-").values());
    expect(leadings.size).toBeGreaterThan(0);
    const { found, stale } = check((d) => d.prop === "line-height" && leadings.has(d.value), []);
    expect(found).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("a transition or animation takes its time from the motion table", () => {
    // 1ms and under is not a duration, it is "no motion" that still fires its end
    // event (the reduced-motion rules); 0s is a delay or a property that only switches
    const real = (v: string) => [...v.matchAll(/(?<![\w.-])(\d*\.?\d+)(m?s)\b/g)].some((m) => Number(m[1]) * (m[2] === "s" ? 1000 : 1) > 1);
    const { found, stale } = check((d) => /^(?:transition|animation)(?:-|$)/.test(d.prop) && real(d.value), []);
    expect(found).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("z-index takes its layer from the scale", () => {
    const { found, stale } = check(
      // -1, 0 and 1 order things inside one component's own stacking context, and say
      // nothing about the page's layers
      (d) => d.prop === "z-index" && !/var\(--z-[a-z]+\)/.test(d.value) && !/^(?:-1|0|1)$/.test(d.value),
      [
        {
          file: "app/components/RouteMap.client.vue",
          prop: "z-index",
          value: "500",
          why: "Leaflet's own pane scale, inside the map's stacking context: its controls sit at 800-1000",
        },
      ],
    );
    expect(found).toEqual([]);
    expect(stale).toEqual([]);
  });
});
