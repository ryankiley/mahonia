// WCAG's contrast arithmetic, for inks worked out against a colour somebody picked: /trail-spin's
// background, where the theme's fixed greys fall short over a mid-tone (pages/trail-spin.vue).
// Colours are [r, g, b], 0 to 255.
export type Rgb = readonly [number, number, number];

/** "#rrggbb", as a colour input gives it. */
export function rgbOf(hex: string): Rgb {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
}

/** WCAG's relative luminance: 0 for black, 1 for white. */
export function luminance([r, g, b]: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG's contrast ratio, 1 to 21, whichever way round. */
export function contrast(a: Rgb, b: Rgb): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `share` of the way from one colour to the other. */
export const mix = (from: Rgb, to: Rgb, share: number): Rgb =>
  from.map((c, i) => c + (to[i]! - c) * share) as unknown as Rgb;

/** The least share of `ink` over `back`, `share` or more, whose mix reads at `need`:1
 *  against `against`, in steps of 2%: all the way to the ink itself when nothing less does. */
export function readableShare(back: Rgb, ink: Rgb, share: number, against: Rgb, need: number): number {
  let s = share;
  while (s < 1 && contrast(mix(back, ink, s), against) < need) s = Math.min(1, s + 0.02);
  return s;
}
