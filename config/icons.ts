import type { Plugin } from "vite";

// The icon set, trimmed the way a hiker trims a pack: same gear, tags cut off.
//
// @hugeicons/core-free-icons ships every glyph's path data with four decimals on a
// 24-unit grid — "C18.8137 14.5 21.5 11.8137 21.5 8.5". The app draws them at 14, 16
// and 24px, where the fourth decimal is a hundred-thousandth of a pixel and the third
// is a ten-thousandth. Rounding to two leaves a worst-case displacement of 0.005
// units: 0.003px at 14px, 0.007px at 32px, both under one 8-bit coverage level of
// anti-aliasing. Proven rather than assumed, 2026-09-12: every glyph in the build was
// rasterised before and after, at each of those sizes and at 8× with a box filter to
// approximate a browser's analytic coverage. The worst delta was the same 8/255 at
// two decimals as at THREE — a 0.0003px shift — which is the rasteriser's own
// supersampling quantum, not the rounding. The eye has no such quantum.
//
// What it buys: a quarter of the icon set's weight (11.2 → 8.6 KB brotli across the
// 68 glyphs in the build; ~1.3 KB of it on the editor's first load), on every route,
// with no call site touched and the rendered markup identical apart from the shorter
// `d` strings. The number the bundle ratchet reads is a hair under 1% of the
// framework floor — small, but the glyphs are the third-largest line on that first
// load, and this is the cheapest byte per glyph there is.
//
// BUILD ONLY (`apply: "build"`). In dev, Vite pre-bundles node_modules with esbuild
// and serves the result past every `transform`, while SSR loads the same module
// through the plugin pipeline — so a dev-time transform would round the server's
// paths and not the client's, and every SSR'd icon on the share views would raise a
// hydration mismatch on its `d`. Production builds run both sides through this hook,
// and dev leaves both at full precision; each is consistent with itself.
//
// Only numbers with a decimal point are touched, so an arc's flags (integers) and
// any exponent form stay as they are. `key`, `stroke` and `strokeWidth` on each path
// are NOT stripped, though the renderer restamps two of them: brotli already folds
// that boilerplate to nothing (measured: 0.26 KB across the set), and the
// attribute order they hold is what tests/hugeicon.nuxt.test.ts pins against
// upstream's own output.
export function hugeiconsPrecision(decimals = 2): Plugin {
  const factor = 10 ** decimals;
  const round = (n: string) => String(Math.round(parseFloat(n) * factor) / factor);
  return {
    name: "mahonia:hugeicons-precision",
    apply: "build",
    enforce: "pre",
    transform(code, id) {
      if (!/node_modules\/@hugeicons\/core-free-icons\/dist\/esm\/[^/]+\.js$/.test(id)) return null;
      const out = code.replace(/d:\s*"([^"]+)"/g, (_, d: string) => `d: "${d.replace(/-?\d+\.\d+/g, round)}"`);
      return out === code ? null : { code: out, map: null };
    },
  };
}
