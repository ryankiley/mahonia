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
