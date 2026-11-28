// A card as wide as what's in it, not the width its words wrapped at.
//
// A box sized to its content is as wide as that content would be on one line, up to its
// max-width. Once a line wraps, the box stays at the max-width while the wrapped lines fall
// short of it, and the card reads as padded on one side. CSS can't ask for the widest line,
// so this measures how far right anything in the card reaches: every line of its text (a
// Range's client rects) and every control or picture (its box), and pulls the card in to
// that, plus its padding. Shrinking can't rewrap anything (every line already fits), so the
// breaks stay where they were.
//
// A card of rows is left alone: its rows are buttons that run the card's full width, so
// nothing is short of the edge. MenuList calls this on every card it shows (app/components).
export function hugText(el: HTMLElement): void {
  el.style.inlineSize = "";
  const box = el.getBoundingClientRect();
  // A menu card arrives scaled (the .menu enter transition), and client rects are drawn
  // sizes: the layout width says how much to undo.
  const scale = box.width / el.offsetWidth || 1;
  const s = getComputedStyle(el);
  const px = (v: string) => Number.parseFloat(v) || 0;
  const inset = px(s.borderLeftWidth) + px(s.paddingLeft);
  const outset = px(s.paddingRight) + px(s.borderRightWidth);
  const left = box.left + inset * scale;
  const room = el.offsetWidth - inset - outset;
  let reach = 0;
  const range = document.createRange();
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
  // nothing to pull in: a card of rows, or one whose words don't wrap
  if (used <= 0 || used >= room - 1) return;
  el.style.inlineSize = `${Math.ceil(used + inset + outset)}px`;
}
