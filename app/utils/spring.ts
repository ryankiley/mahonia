// The motion table, in JS: the same five roles tokens.scss declares on :root (the
// "motion" block there), with the fallbacks a read of them needs. A retune changes both
// files. The NAMES are historical — two of the five (fade, track) are still springs
// sampled into linear() easings; step, move and pop are cubic-béziers now — and the
// rename is due in both files together.
//
// The stylesheet keeps the motion; this file is for the one thing CSS can't do on its
// own: a Web Animation that must run on a token's own curve and beat (springCss).
//
// `dur` is what the -dur token holds: the visible duration for a bézier, and 1.5x the
// period for a sampled spring (its settle tail — spring-curve() in tokens.scss). `css` is
// the curve a failed read falls back to: the token's own bézier, or the strong ease-out
// both sampled springs trace.
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";
const EASE_DRAWER = "cubic-bezier(0.32, 0.72, 0, 1)";
const SPRINGS = {
  fade: { dur: 300, css: EASE_OUT },
  step: { dur: 250, css: EASE_IN_OUT },
  move: { dur: 350, css: EASE_DRAWER },
  pop: { dur: 200, css: EASE_OUT },
  track: { dur: 210, css: EASE_OUT },
} as const;
type SpringName = keyof typeof SPRINGS;

/**
 * A role as the stylesheet runs it, for a Web Animation that must match a CSS
 * transition on the same beat: the token's easing and its duration, read off :root —
 * so a reduced-motion visitor gets the 0.01ms the tokens drop to there. The fallback is
 * the token's own value, for a read that fails (SSR, a test).
 */
export function springCss(name: SpringName): { easing: string; duration: number } {
  const cs = typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
  const easing = cs?.getPropertyValue(`--spring-${name}`).trim() || SPRINGS[name].css;
  const duration = parseFloat(cs?.getPropertyValue(`--spring-${name}-dur`) ?? "") || SPRINGS[name].dur;
  return { easing, duration };
}
