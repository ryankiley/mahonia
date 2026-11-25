import { type FunctionalComponent, h, mergeProps } from "vue";

// <SvgIcon :icon size> draws one glyph from its data: an array of
// [tag, attrs] pairs. The glyphs are Central's (app/icons/central, generated
// from the licensed package) and Mahonia's own (app/icons/mahonia, drawn in
// Central's grammar for what it doesn't draw). Both are plain data, so a glyph costs
// its path strings and nothing else, and RouteMap can serialise one for a map pin.
//
// SIZE is a named step (ICON_SIZES), not a number, so a step moves in one place: CSS sizes
// each step from its token (--icon-xs … --icon-xl, tokens.scss; main.scss applies them),
// and they grow with the type past 1920px. The width/height attributes carry the same
// numbers for the moment before the stylesheet arrives; tests/icon.nuxt.test.ts holds the
// two in step.
//
// STROKE is flat: a fixed width in screen pixels for each step, at every viewport. The
// <svg> carries it and main.scss gives the glyph's parts non-scaling-stroke, so the line
// doesn't thicken as the glyph grows past 1920px, or between a 14px glyph and a 20px one.
// Small steps draw lighter, because Central's strokes sit about four grid units apart and
// a 1.5px line on a 14px glyph fills those gaps in. A glyph's data carries no width of its
// own except where a part is meant to differ (Central's filled dots keep their hairline),
// and those keep theirs. A call site's :stroke-width is in screen pixels too.
//
// WHY a functional component with cached children: the editor puts ~9 icons on every gear
// row, so a 150-item list mounts ~1,450 of these, and a mode switch (Gear↔Packing) tears
// the rows down and builds them again. A glyph's kebab-cased attributes never change, so
// they are computed once per glyph and every render is a plain h() over prepared objects.
//
// To regenerate app/icons/central (after changing a pick, or a package update): install the
// style with CENTRAL_LICENSE_KEY set, outside this repo (the package's install script
// checks the key, and keeping it out of package.json keeps the key off CI and Vercel),
// then render each glyph with `mode: "raw"` and write it out in the same shape.

/** One drawn element: an SVG tag plus its attributes, camelCased. */
export type IconChild = readonly [string, { readonly [key: string]: string | number }];
export type IconNode = readonly IconChild[];

/** Prepared child: the tag, and its attributes kebab-cased for SVG. */
type PreparedChild = { tag: string; attrs: Record<string, unknown> };

// The same handful of attribute names (d, stroke, strokeLinecap, …) recur across every
// glyph, so the case conversion is worth memoising on its own.
const kebabCache = new Map<string, string>();
/** an attribute's camelCase name as SVG spells it — strokeLinecap → stroke-linecap.
 *  Exported for the map's pin glyphs, which serialise the same icon data by hand. */
export function kebab(key: string): string {
  let out = kebabCache.get(key);
  if (out === undefined) {
    out = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    kebabCache.set(key, out);
  }
  return out;
}

// Keyed by the glyph ARRAY's identity, which is safe because the glyphs are module-level
// constants: the same import is the same array for the life of the page. Weak so a glyph
// that falls out of use (a lazily-loaded route unmounting) can be collected.
const prepared = new WeakMap<IconNode, PreparedChild[]>();

function childrenFor(icon: IconNode): PreparedChild[] {
  let built = prepared.get(icon);
  if (!built) {
    built = icon.map(([tag, attrs]): PreparedChild => {
      const out: Record<string, unknown> = {};
      for (const key in attrs) if (key !== "key") out[kebab(key)] = attrs[key];
      return { tag, attrs: out };
    });
    prepared.set(icon, built);
  }
  return built;
}

/** The icon scale: each step's size in px (its --icon-* token in tokens.scss says the
 *  same) and the flat line it draws, in screen px. md is the default: the glyph beside
 *  16px text, on every pointer, and the folder chevrons and gear marks too (one size where
 *  there were 18 and 20). sm sits beside 14px text and in small indicators (a menu's
 *  chevron and tick). */
export const ICON_SIZES = {
  xs: { px: 12, stroke: 1 },
  sm: { px: 14, stroke: 1.25 },
  md: { px: 20, stroke: 1.5 },
  xl: { px: 24, stroke: 1.5 },
} as const;
export type IconSize = keyof typeof ICON_SIZES;

interface SvgIconProps {
  icon: IconNode;
  size?: IconSize;
  /** the drawn line in screen px, when a glyph must differ from its step's */
  strokeWidth?: number;
  altIcon?: IconNode;
  showAlt?: boolean;
  color?: string;
}

export const SvgIcon: FunctionalComponent<SvgIconProps> = (props, { attrs }) => {
  const step = props.size && props.size in ICON_SIZES ? props.size : "md";
  const { px, stroke } = ICON_SIZES[step];
  const icon = props.altIcon && props.showAlt ? props.altIcon : props.icon;

  return h(
    "svg",
    mergeProps(
      {
        class: `svgicon svgicon--${step}`,
        width: px,
        height: px,
        viewBox: "0 0 24 24",
        xmlns: "http://www.w3.org/2000/svg",
        fill: "none",
        color: props.color ?? "currentColor",
        "stroke-width": props.strokeWidth ?? stroke,
      },
      attrs,
    ),
    childrenFor(icon).map((c) => h(c.tag, c.attrs)),
  );
};

SvgIcon.props = {
  icon: { type: Array, required: true },
  size: { type: String, default: "md" },
  strokeWidth: { type: Number, default: undefined },
  altIcon: { type: Array, default: undefined },
  showAlt: { type: Boolean, default: false },
  color: { type: String, default: "currentColor" },
} as never;
SvgIcon.inheritAttrs = false;
SvgIcon.displayName = "SvgIcon";
