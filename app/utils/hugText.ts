// A card as wide as what's in it, not the width its words wrapped at.
//
// A box sized to its content is as wide as that content would be on one line, up to its
// max-width. Once a line wraps, the box stays at the max-width while the wrapped lines fall
// short of it, and the card reads as padded on one side. CSS can't ask for the widest line,
// so this measures how far right anything in the card reaches: every line of its text (a
// Range's client rects) and every control or picture (its box), and pulls the card in to
// that, plus its padding.
//
// AND MEASURES AGAIN. Narrowing the card can re-break its text: the app's paragraphs wear
// `text-wrap: pretty` (reset.scss), and WebKit, given the narrower card, pulled words down
// to keep a lone "video." off the last line, so the lines came out shorter than the width
// they were measured at and the card was left padded on one side again (Ryan's phone,
// 2026-11-28). So it narrows until the lines stop moving, three passes at most: a pass can
// only shrink the card, and two settle a two-line card.
//
// A card of rows is left alone: its rows are buttons that run the card's full width, so
// nothing is short of the edge. MenuList calls this on every card it shows (app/components).
const PASSES = 3;

export function hugText(el: HTMLElement): void {
  el.style.inlineSize = "";
  const s = getComputedStyle(el);
  const px = (v: string) => Number.parseFloat(v) || 0;
  const inset = px(s.borderLeftWidth) + px(s.paddingLeft);
  const outset = px(s.paddingRight) + px(s.borderRightWidth);
  const range = document.createRange();
  for (let pass = 0; pass < PASSES; pass++) {
    const box = el.getBoundingClientRect();
    // A menu card arrives scaled (the .menu enter transition), and client rects are drawn
    // sizes: the layout width says how much to undo.
    const scale = box.width / el.offsetWidth || 1;
    const left = box.left + inset * scale;
    const room = el.offsetWidth - inset - outset;
    let reach = 0;
    const texts = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = texts.nextNode(); t; t = texts.nextNode()) {
      if (!t.textContent?.trim()) continue;
      range.selectNodeContents(t);
      for (const line of range.getClientRects()) reach = Math.max(reach, line.right);
    }
    for (const thing of el.querySelectorAll("button, input, select, textarea, img, svg, video, canvas")) {
      reach = Math.max(reach, thing.getBoundingClientRect().right);
    }
    const used = (reach - left) / scale;
    // nothing (more) to pull in: a card of rows, one whose words don't wrap, or one settled
    if (used <= 0 || used >= room - 1) return;
    el.style.inlineSize = `${Math.ceil(used + inset + outset)}px`;
  }
}
