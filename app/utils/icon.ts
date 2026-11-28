import { type FunctionalComponent, h, mergeProps } from "vue";

// <SvgIcon :icon size> draws one glyph from its data: an array of
// [tag, attrs] pairs. The glyphs are Central's (app/icons/central, generated
// from the licensed package) and Mahonia's own (app/icons/mahonia, drawn in
// Central's grammar for what it doesn't draw). Both are plain data, so a glyph costs
// its path strings and nothing else, and RouteMap can serialise one for a map pin.
//
// SIZE is a named step (ICON_STROKES' keys), not a number, so a step moves in one place:
// CSS sizes each step from its token (--icon-xs … --icon-xl, tokens.scss; main.scss
// applies them), and they grow with the type past 1920px. The width/height attributes are
// only a fallback for the moment before the stylesheet arrives, so every step carries the
// same one, the default step's 20px, and the px of each step is stated only in CSS.
//
// STROKE is flat: a fixed width in screen pixels for each step, at every viewport. The
// <svg> carries it and main.scss gives the glyph's parts non-scaling-stroke, so the line
// doesn't thicken as the glyph grows past 1920px, or between a 14px glyph and a 20px one.
// Small steps draw lighter, because Central's strokes sit about four grid units apart and
// a 1.5px line on a 14px glyph fills those gaps in. A glyph's data carries no width of its
// own except where a part is meant to differ (Central's filled dots keep their hairline),
// and those keep theirs. A call site's :stroke-width is in screen pixels too.
//
// WHY a functional component: the editor puts ~9 icons on every gear row, so a 150-item
// list mounts ~1,450 of these, and a mode switch (Gear↔Packing) tears the rows down and
// builds them again. The glyph data is stored under its final SVG attribute names, so a
// render is a plain h() over the glyph's own objects, with nothing to convert.
//
// To regenerate app/icons/central (after changing a pick, or a package update): install the
// style with CENTRAL_LICENSE_KEY set, outside this repo (the package's install script
// checks the key, and keeping it out of package.json keeps the key off CI and Vercel),
// then render each glyph with `mode: "raw"` and write it out in the same shape, with each
// attribute under the name SVG spells it (`"stroke-linecap"`, not the package's
// `strokeLinecap`): SVG ignores a name it doesn't know, silently, so a glyph written in
// camelCase would lose its caps and joins without an error. tests/icon.nuxt.test.ts
// refuses one.

/** One drawn element: an SVG tag plus its attributes, under the names SVG spells them. */
export type IconChild = readonly [string, { readonly [key: string]: string | number }];
export type IconNode = readonly IconChild[];

/** The icon scale: each step's flat line, in screen px (its size is its --icon-* token in
 *  tokens.scss). md is the default: the glyph beside 16px text, on every pointer, and the
 *  folder chevrons and gear marks too (one size where there were 18 and 20). sm sits
 *  beside 14px text and in small indicators (a chevron). A menu's tick is md, the leading
 *  icons' size, since 2026-11-27. */
export const ICON_STROKES = {
  xs: 1,
  sm: 1.25,
  md: 1.5,
  xl: 1.5,
} as const;
export type IconSize = keyof typeof ICON_STROKES;

/** width/height for the instant before the stylesheet sizes the step: md's 20px. */
const FALLBACK_PX = 20;

interface SvgIconProps {
  icon: IconNode;
  size?: IconSize;
  /** the drawn line in screen px, when a glyph must differ from its step's */
  strokeWidth?: number;
}

export const SvgIcon: FunctionalComponent<SvgIconProps> = (props, { attrs }) => {
  const step = props.size && props.size in ICON_STROKES ? props.size : "md";

  return h(
    "svg",
    mergeProps(
      {
        class: `svgicon svgicon--${step}`,
        width: FALLBACK_PX,
        height: FALLBACK_PX,
        viewBox: "0 0 24 24",
        xmlns: "http://www.w3.org/2000/svg",
        fill: "none",
        color: "currentColor",
        "stroke-width": props.strokeWidth ?? ICON_STROKES[step],
      },
      attrs,
    ),
    props.icon.map(([tag, a]) => h(tag, a)),
  );
};

SvgIcon.props = {
  icon: { type: Array, required: true },
  size: { type: String, default: "md" },
  strokeWidth: { type: Number, default: undefined },
} as never;
SvgIcon.inheritAttrs = false;
SvgIcon.displayName = "SvgIcon";
