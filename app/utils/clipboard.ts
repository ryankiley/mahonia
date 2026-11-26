// Copy text to the clipboard from within a click handler. Prefers the async
// Clipboard API in a secure context; falls back to a synchronous execCommand off a
// hidden textarea where that API is missing or blocked (older/embedded browsers, or
// an insecure origin). Both paths run inside the caller's user gesture — the gesture
// iOS Safari demands for a clipboard write — so callers must `await` this directly in
// the handler, not after an unrelated network await. Returns whether the copy landed;
// the caller decides how loudly to report it. Nuxt auto-imports app/utils, so callers
// use copyText(...) bare.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // async API unavailable or rejected — fall through to the legacy path, still
    // within the user gesture.
  }
  return legacyCopy(text);
}

/** What a caller says when the copy didn't land and it has nothing better to offer
 *  (the trail link, the two text exports): one sentence, spelled once. A caller with a
 *  way round the clipboard says that instead (the editor shows the link to copy by hand). */
export const COPY_FAILED = "Couldn’t copy. Try again.";

// Copy text that isn't known yet: a link to a list that is being saved by the same
// click. Awaiting the text and THEN writing spends the gesture (Safari refuses a
// write that follows a network await), so the write starts now and is handed the
// text as a promise, which is what ClipboardItem takes for exactly this. Where that
// isn't on offer or is refused, it waits and copies the plain way, which Chrome and
// Firefox allow shortly after a click. False when neither lands, and also when the
// text never arrives (the promise rejects); the caller tells those apart by the
// promise it still holds.
export async function copyTextWhen(text: Promise<string>): Promise<boolean> {
  try {
    if (navigator.clipboard?.write && window.isSecureContext && typeof ClipboardItem !== "undefined") {
      const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
      // a write refused on the spot never reads the blob, and if the text then fails
      // to arrive its rejection would be nobody's; the path below reports it
      blob.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return true;
    }
  } catch {
    // refused, or the text never came — the plain path below answers both
  }
  try {
    return await copyText(await text);
  } catch {
    return false;
  }
}

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // off-screen but still selectable; fixed + opacity:0 avoids iOS scroll-to-field + zoom
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
