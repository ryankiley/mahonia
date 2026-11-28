// Trigger a client-side download of an in-memory string (a Blob + a synthetic <a>
// click). Used by the list exporters (CSV / JSON) in the editor and the read-only
// share views. Nuxt auto-imports app/utils, so callers use downloadFile(...) /
// listFileBase(...) bare.
export function downloadFile(filename: string, text: string, type: string): void {
  // A CSV leads with a byte-order mark. Excel opens a CSV without one as Windows-1252,
  // so every curly apostrophe tidyText writes ("Arc’teryx", "Men’s") came out as
  // "Arcâ€™teryx" there; Numbers and Sheets read either. Our own importer reads past
  // the mark (a header cell is trimmed, and trim() takes U+FEFF).
  const body = type === "text/csv" ? `\uFEFF${text}` : text;
  const url = URL.createObjectURL(new Blob([body], { type: type === "text/csv" ? "text/csv;charset=utf-8" : type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoke off the click task — WebKit (iOS Safari) can race a synchronous
  // revoke against the download fetch and save an empty file. The blob is a
  // small in-memory string, so holding it a beat costs nothing.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A filesystem-friendly base name for an exported list, named after the list's NAME
// (what the user typed) — e.g. "Summer JMT" → "summer-jmt.json" — so the saved file
// is recognisable. Falls back to the URL slug, then "gear" (an unnamed draft has
// neither a title nor a slug yet).
export function listFileBase(title?: string | null, slug?: string | null): string {
  const fromTitle = (title || "")
    .trim()
    // accents come off rather than taking their letter with them: "Haleakalā" is
    // haleakala.csv, not haleakal.csv, and "Señal Peak" is senal-peak, not se-al-peak
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return fromTitle || slug || "gear";
}
