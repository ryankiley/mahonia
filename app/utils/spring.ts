// The spring table, in JS: the same springs tokens.scss samples into linear() easings
// at build time (spring-curve there), as (nominal duration, bounce). A retune changes
// both files. The stylesheet keeps the motion; this file is for the one move CSS can't
// make — one caught in flight carrying on at the speed it has (springTiming, run as a
// Web Animation) — and for a Web Animation that must run on a token's own curve (springCss).
export const SPRINGS = { fade: [200, 0], step: [260, 0], move: [420, 0], pop: [380, 0.2], track: [140, 0] } as const;
export type SpringName = keyof typeof SPRINGS;

export interface Spring {
  stiffness: number;
  damping: number;
}

/** duration + bounce → stiffness/damping, mass 1. */
function springOf(ms: number, bounce = 0): Spring {
  const d = ms / 1000;
  return { stiffness: (2 * Math.PI / d) ** 2, damping: (4 * Math.PI * (1 - bounce)) / d };
}
export const spring = (name: SpringName): Spring => springOf(SPRINGS[name][0], SPRINGS[name][1]);

/** Displacement at t seconds of a spring released from x0 at velocity v0 (per second). */
export function springAt(t: number, { stiffness, damping }: Spring, x0: number, v0: number): number {
  const w0 = Math.sqrt(stiffness);
  const zeta = damping / (2 * w0);
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return Math.exp(-zeta * w0 * t) * (x0 * Math.cos(wd * t) + ((v0 + zeta * w0 * x0) / wd) * Math.sin(wd * t));
  }
  return (x0 + (v0 + w0 * x0) * t) * Math.exp(-w0 * t);
}

/**
 * A spring from progress 0 to 1 that starts at velocity v (progress per ms), as a
 * linear() easing plus the duration it needs. px is the on-screen distance, so the
 * path ends when the motion is within half a pixel of landing and stays there. v is
 * capped toward the target at the spring's own natural speed, so a hard throw lands
 * instead of overshooting; away from it there is no cap, since that is precisely the
 * reversal this exists to carry. v0 is the speed it used (per second), so a caller can
 * ask springAt where the move is later.
 */
export function springTiming(sp: Spring, v = 0, px = 100): { duration: number; easing: string; v0: number } {
  const w = Math.sqrt(sp.stiffness);
  const v0 = Math.min(v * 1000, w);
  const path: number[] = [];
  for (let i = 0, still = 0; ; i++) {
    const p = 1 + springAt(i / 60, sp, -1, v0);
    path.push(p);
    still = Math.abs(1 - p) * px < 0.5 ? still + 1 : 0;
    if (still > 2 || i > 120) break;
  }
  path[path.length - 1] = 1;
  return { duration: ((path.length - 1) * 1000) / 60, easing: `linear(${path.map((p) => +p.toFixed(4)).join(", ")})`, v0 };
}

/**
 * A spring as the stylesheet runs it, for a Web Animation that must match a CSS
 * transition on the same beat: the token's sampled linear() easing and its duration,
 * read off :root. The fallback is the token's own value, for a read that fails.
 */
export function springCss(name: SpringName): { easing: string; duration: number } {
  const cs = typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
  const easing = cs?.getPropertyValue(`--spring-${name}`).trim() || "ease-out";
  const duration = parseFloat(cs?.getPropertyValue(`--spring-${name}-dur`) ?? "") || SPRINGS[name][0] * 1.5;
  return { easing, duration };
}
