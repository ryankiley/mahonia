// Pure catalog data-quality helpers shared by the build pipeline, the runtime
// server (community intake), and tests. No DB, no node-only deps.

// --- Variant canonical formatting -----------------------------------------
// `variant` is a single free-text slot that crams multiple dimensions (fabric,
// size, temp, volume). normalizeVariant() gives it ONE consistent style so the
// catalog reads like a spec sheet and the UI can render it predictably:
//   • dimensions separated by ", "
//   • orphan leading/trailing punctuation stripped ("/ M" → "M", ", 18F" → "18F")
//   • temperature: no degree symbol, no space, uppercase ("20°F" → "20F", "-6 c" → "-6C")
//   • volume: no parens/space, uppercase L ("(68 L)" → "68L")
//   • trailing parenthetical qualifiers unwrapped ("Regular (6 ft)" → "Regular, 6 ft")
//   • KEEP genuine tokens: size ranges ("S/M", "L/XL", "M/L torso") and spaced
//     unit/temperature equivalents ("32oz / 1L", "20F / -6C", '16" / 19"')

const SIZE_TOKEN = /^W?(XS|S|M|L|XL|XXL|XXXL)$/i;
const isSizeTok = (s: string) => SIZE_TOKEN.test(s.trim());
// crude "looks like a measured value": has a digit AND a unit-ish char (letter, ", ')
const hasNumUnit = (s: string) => /\d/.test(s) && /[a-zA-Z"']/.test(s);

/** Strip orphan leading/trailing separators + whitespace from one dimension. */
function cleanDim(s: string): string {
  return s.replace(/^[\s,/]+/, "").replace(/[\s,/]+$/, "").replace(/\s+/g, " ").trim();
}

export function normalizeVariant(input: string | null | undefined): string {
  let v = (input ?? "").trim();
  if (!v) return "";
  // 1. unwrap trailing/inline parenthetical qualifiers into ", " dimensions
  v = v.replace(/\s*\(\s*([^()]*?)\s*\)/g, (_m, inner: string) => `, ${inner.trim()}`);
  // 2. temperature: "20°F" / "20 F" / "-6 c" → "20F" / "-6C" (degree dropped, uppercased)
  v = v.replace(/(-?\d+(?:\.\d+)?)\s*°?\s*([FfCc])\b/g, (_m, n: string, u: string) => `${n}${u.toUpperCase()}`);
  // 3. volume: a number followed by L (with optional space) → "<n>L" (only when a digit precedes L,
  //    so size letters like the L in "L/XL" are untouched; "90mL" untouched — 'm' breaks the match)
  v = v.replace(/\b(\d+(?:\.\d+)?)\s*[lL]\b/g, (_m, n: string) => `${n}L`);
  // 4. split into dimensions: top-level commas, then SPACED " / " separators (an UNSPACED "/" stays
  //    inside its token — that's a real size range like S/M or M/L)
  const dims: string[] = [];
  for (const seg of v.split(",")) {
    const parts = seg.split(/\s+\/\s+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2 && parts.every(hasNumUnit)) {
      // a spaced unit/temp equivalent ("32oz / 1L", "20F / -6C") — keep joined with " / "
      dims.push(parts.join(" / "));
    } else {
      // distinct dimensions ("Ultra 200X / M" → two) — or a single token
      for (const p of parts) dims.push(p);
    }
  }
  return dims.map(cleanDim).filter(Boolean).join(", ");
}
