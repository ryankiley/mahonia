// One pixel of the type, as a number: exactly 1 up to the 1920px anchor, and growing with
// --text-base past it. The script side of the stylesheet's --tpx (tokens.scss), for the
// gaps a script places things with (a menu's distance from its trigger, a tooltip's from
// the window's edge), so they open up with the spacing the CSS draws around them instead
// of staying at their px values beside 25px type on a 3000px window.
//
// Read off the body, whose font-size IS --text-base (typography.scss). Keep this file
// IMPORT-FREE, like app/utils/site.ts: anything can import it without pulling a chunk.

export function typeScale(): number {
  if (typeof document === "undefined" || !document.body) return 1;
  return parseFloat(getComputedStyle(document.body).fontSize) / 16 || 1;
}
