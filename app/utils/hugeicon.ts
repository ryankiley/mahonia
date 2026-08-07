import { type FunctionalComponent, h, mergeProps } from "vue";

// A drop-in for @hugeicons/vue's <HugeiconsIcon>, rendering byte-identical markup for a
// fraction of the work. Same tag name, same props, same DOM — only the cost differs.
//
// WHY: the editor puts ~9 icons on every gear row, so a 150-item list mounts ~1,450 of
// these, and a mode switch (Gear↔Packing) tears the rows down and builds them again. The
// upstream component makes that far more expensive than it needs to be, three times over,
// on EVERY render of EVERY instance:
//
//   1. `resolveDynamicComponent(element[0])` — a component-registry lookup per child
//      element, to resolve the string "path" that is already a plain SVG tag.
//   2. `transformAttrs()` — a regex kebab-case pass over every attribute of every child,
//      allocating a fresh props object each time. The icon data never changes, so this
//      recomputes a constant.
//   3. the resulting vnodes carry FULL_PROPS, so Vue full-diffs every path's attributes
//      on every patch instead of taking a fast path.
//
// Plus three `computed()` refs per instance, on a component that is a pure function of
// its props.
//
// The fix is the observation that an icon's markup is fully determined by (icon data,
// resolved stroke width) — and the app draws 28 distinct icons across those ~1,450
// instances. So the kebab-cased child attrs are computed once per pair and cached; a
// render is then a plain h() over prepared objects.
//
// Kept as a FUNCTIONAL component: no instance state, no computeds, no props proxy.
//
// Faithfulness matters more than speed here — the markup must not shift, so the details
// below mirror upstream exactly rather than being tidied. See tests/hugeicon.nuxt.test.ts,
// which asserts this renders the same string as @hugeicons/vue for every icon the app uses.

/**
 * One drawn element: an SVG tag plus its attributes, as the icon packages ship it.
 * Mirrors @hugeicons/core-free-icons' own `IconSvgObject` — including `readonly`, which
 * some of its exports carry, and numeric attribute values, which a few glyphs use.
 */
export type IconChild = readonly [string, { readonly [key: string]: string | number }];
export type IconNode = readonly IconChild[];

/** Prepared child: the tag, and its attributes already kebab-cased and stroke-stamped. */
type PreparedChild = { tag: string; attrs: Record<string, unknown> };

// The same handful of attribute names (d, stroke, strokeLinecap, …) recur across every
// icon in the set, so the case conversion is worth memoising on its own.
const kebabCache = new Map<string, string>();
function kebab(key: string): string {
  let out = kebabCache.get(key);
  if (out === undefined) {
    out = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    kebabCache.set(key, out);
  }
  return out;
}

// icon data → resolved stroke width → prepared children. Keyed by the icon ARRAY's
// identity, which is safe because the icon packages export frozen module-level
// constants: the same import is the same array for the life of the page. Weak so an
// icon that falls out of use (a lazily-loaded route unmounting) can be collected.
const prepared = new WeakMap<IconNode, Map<string, PreparedChild[]>>();

function childrenFor(icon: IconNode, strokeWidth: number | undefined): PreparedChild[] {
  let byStroke = prepared.get(icon);
  if (!byStroke) prepared.set(icon, (byStroke = new Map()));
  const cacheKey = strokeWidth === undefined ? "" : String(strokeWidth);
  const hit = byStroke.get(cacheKey);
  if (hit) return hit;

  const built = icon.map(([tag, attrs]): PreparedChild => {
    const out: Record<string, unknown> = {};
    for (const key in attrs) out[kebab(key)] = attrs[key];
    // Upstream stamps these AFTER copying the icon's own attributes. Order matters for
    // the rendered attribute order, and assigning a key that already exists leaves it
    // in its original position — so an icon that ships its own `stroke`/`strokeWidth`
    // keeps that slot and only takes the new value. Mirrored exactly.
    if (strokeWidth !== undefined) {
      out["stroke-width"] = strokeWidth;
      out["stroke"] = "currentColor";
    }
    return { tag, attrs: out };
  });
  byStroke.set(cacheKey, built);
  return built;
}

export interface HugeiconsIconProps {
  /**
   * `IconNode`, not a type borrowed from upstream: @hugeicons/vue's published types
   * re-export `./components/HugeiconsIcon.vue`, a file its package does not ship, so
   * its component resolved to `any` and no call site was ever checked against it.
   * Typing the data shape here is what makes them checkable at all.
   */
  icon: IconNode;
  size?: number | string;
  strokeWidth?: number;
  /** pin the DRAWN line width regardless of `size` — upstream's absoluteStrokeWidth */
  absoluteStrokeWidth?: boolean;
  altIcon?: IconNode;
  showAlt?: boolean;
  color?: string;
}

export const HugeiconsIcon: FunctionalComponent<HugeiconsIconProps> = (props, { attrs }) => {
  const raw = typeof props.size === "string" ? parseInt(props.size, 10) : props.size;
  const size = typeof raw === "number" && !isNaN(raw) && raw > 0 ? raw : 24;
  const strokeWidth =
    props.strokeWidth === undefined
      ? undefined
      : props.absoluteStrokeWidth
        ? (props.strokeWidth * 24) / size
        : props.strokeWidth;
  const icon = props.altIcon && props.showAlt ? props.altIcon : props.icon;

  return h(
    "svg",
    mergeProps(
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        xmlns: "http://www.w3.org/2000/svg",
        fill: "none",
        color: props.color ?? "currentColor",
      },
      attrs,
    ),
    childrenFor(icon, strokeWidth).map((c) => h(c.tag, c.attrs)),
  );
};

// Declared so Vue separates them from the fall-through attrs (class, aria-hidden, the
// scoped-style marker) that land on the <svg> — same split upstream makes.
HugeiconsIcon.props = {
  icon: { type: Array, required: true },
  size: { type: [Number, String], default: 24 },
  strokeWidth: { type: Number, default: undefined },
  absoluteStrokeWidth: { type: Boolean, default: false },
  altIcon: { type: Array, default: undefined },
  showAlt: { type: Boolean, default: false },
  color: { type: String, default: "currentColor" },
} as never;
HugeiconsIcon.inheritAttrs = false;
HugeiconsIcon.displayName = "HugeiconsIcon";
