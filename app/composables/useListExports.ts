import type { ListSnapshot } from "~~/shared/types";

// The ⋯ menus' three export actions (Copy as Markdown / Download CSV / Download
// JSON) + the exporter warm-up — shared by the editor's kebab (GearEditor) and the
// read views' menu (ReadonlyMenu), so the copy and error handling can't drift.
//
// The exporters are menu actions, not part of either surface's boot path — they
// load on demand. warmExporters() runs when a menu opens: the markdown action's
// clipboard write must stay within iOS Safari's user-gesture window, and a warmed
// import() resolves from module cache in a microtask, so the await in a handler
// doesn't spend the gesture on a network fetch.
//
// `getSnapshot` absorbs the callers' one real difference: the editor's snapshot
// ref is nullable mid-load, the read views' prop is required.
export function useListExports(
  getSnapshot: () => ListSnapshot | null,
  flash: (msg: string) => void,
) {
  const mdExporter = () => import("~~/shared/exporters/markdown");
  const csvExporter = () => import("~~/shared/exporters/csv");
  const jsonExporter = () => import("~~/shared/exporters/json");

  function warmExporters() {
    void mdExporter();
    void csvExporter();
    void jsonExporter();
  }

  // an exporter chunk can fail to load (offline before the SW cached it, or a
  // dropped connection) — the old static imports could never fail, so say so
  const LOAD_FAILED = "Couldn’t load the exporter. Try again.";

  async function copyMarkdown() {
    const snap = getSnapshot();
    if (!snap) return;
    try {
      const { listToMarkdown } = await mdExporter();
      flash((await copyText(listToMarkdown(snap))) ? "Copied as Markdown" : "Copy failed");
    } catch {
      flash(LOAD_FAILED);
    }
  }

  // downloadFile() + listFileBase() (the saved file is named after the list) live
  // in the shared app/utils/download.ts
  async function downloadCsv() {
    const snap = getSnapshot();
    if (!snap) return;
    try {
      const { listToCsv } = await csvExporter();
      downloadFile(`${listFileBase(snap.title, snap.slug)}.csv`, listToCsv(snap), "text/csv");
      flash("CSV downloaded");
    } catch {
      flash(LOAD_FAILED);
    }
  }

  async function downloadJson() {
    const snap = getSnapshot();
    if (!snap) return;
    try {
      // shared/exporters/json.ts also holds the import-side parser, so the backup
      // the import dialog restores is by construction the shape written here
      const { listToJson } = await jsonExporter();
      downloadFile(`${listFileBase(snap.title, snap.slug)}.json`, listToJson(snap), "application/json");
      flash("JSON downloaded");
    } catch {
      flash(LOAD_FAILED);
    }
  }

  return { warmExporters, copyMarkdown, downloadCsv, downloadJson };
}
