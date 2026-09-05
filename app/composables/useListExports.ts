import { Csv01Icon, HashIcon, ThirdBracketIcon, Txt01Icon } from "@hugeicons/core-free-icons";
import type { IconNode } from "~/utils/hugeicon";
import type { ListSnapshot } from "~~/shared/types";

// The ⋯ menus' four export actions (Copy as plain text / Copy as Markdown / Download
// CSV / Download JSON) + the exporter warm-up + the ROWS that draw them — shared by
// the editor's kebab (GearEditor) and the read views' menu (ReadonlyMenu), so neither
// the copy, the error handling nor the menu's own wording and marks can drift.
//
// The exporters are menu actions, not part of either surface's boot path — they
// load on demand. warmExporters() runs when a menu opens: the markdown action's
// clipboard write must stay within iOS Safari's user-gesture window, and a warmed
// import() resolves from module cache in a microtask, so the await in a handler
// doesn't spend the gesture on a network fetch.
//
// `getSnapshot` absorbs the callers' one real difference: the editor's snapshot
// ref is nullable mid-load, the read views' prop is required.
//
// `getShareUrl` is the link the plain-text copy appends, and it is the CALLER'S to
// name rather than something derived here. In the editor `location.href` is the EDIT
// link — pasting that token into a public comment hands the list to everyone who reads
// it — so the editor passes its read-only link and a read view passes the page it's on.
// Returning "" appends nothing.
export function useListExports(
  getSnapshot: () => ListSnapshot | null,
  flash: (msg: string) => void,
  getShareUrl: () => string = () => "",
) {
  const textExporter = () => import("~~/shared/exporters/text");
  const mdExporter = () => import("~~/shared/exporters/markdown");
  const csvExporter = () => import("~~/shared/exporters/csv");
  const jsonExporter = () => import("~~/shared/exporters/json");

  function warmExporters() {
    void textExporter();
    void mdExporter();
    void csvExporter();
    void jsonExporter();
  }

  // Every action has the same skeleton — no snapshot yet means nothing to export;
  // the chunk loads (and can FAIL to load: offline before the SW cached it, or a
  // dropped connection — the old static imports never could, so say so); then the
  // act. Written once, so the four below are only the part that differs.
  const LOAD_FAILED = "Couldn’t load the exporter. Try again.";
  async function withExporter<M>(
    load: () => Promise<M>,
    act: (mod: M, snap: ListSnapshot) => Promise<void> | void,
  ) {
    const snap = getSnapshot();
    if (!snap) return;
    try {
      await act(await load(), snap);
    } catch {
      flash(LOAD_FAILED);
    }
  }

  // The list as one run of prose, for a box that strips formatting — a YouTube or
  // Instagram comment answering "what's in that pack?".
  //
  // The toast NAMES the appended link rather than just saying "Copied". A share link is
  // otherwise an unguessable private one, and this action exists to put its result
  // somewhere public, so the clipboard shouldn't be the first place you find out a link
  // is in there. It says READ-ONLY because that's the reassurance worth giving in the
  // editor, where the link you're looking at is the edit one — and it stays true on the
  // read views, whose URLs are read-only by construction.
  const copyPlainText = () =>
    withExporter(textExporter, async ({ listToText }, snap) => {
      const shareUrl = getShareUrl();
      const ok = await copyText(listToText(snap, { shareUrl }));
      flash(ok ? (shareUrl ? "Copied — includes the read-only link" : "Copied as plain text") : "Copy failed");
    });

  const copyMarkdown = () =>
    withExporter(mdExporter, async ({ listToMarkdown }, snap) => {
      flash((await copyText(listToMarkdown(snap))) ? "Copied as Markdown" : "Copy failed");
    });

  // downloadFile() + listFileBase() (the saved file is named after the list) live
  // in the shared app/utils/download.ts
  const downloadCsv = () =>
    withExporter(csvExporter, ({ listToCsv }, snap) => {
      downloadFile(`${listFileBase(snap.title, snap.slug)}.csv`, listToCsv(snap), "text/csv");
      flash("CSV downloaded");
    });

  // shared/exporters/json.ts also holds the import-side parser, so the backup the
  // import dialog restores is by construction the shape written here
  const downloadJson = () =>
    withExporter(jsonExporter, ({ listToJson }, snap) => {
      downloadFile(`${listFileBase(snap.title, snap.slug)}.json`, listToJson(snap), "application/json");
      flash("JSON downloaded");
    });

  /**
   * THE FOUR ROWS, in the order both menus draw them — label, mark and act together,
   * so an export is one entry here rather than a hand-written <li> in each menu. They
   * were declared twice (GearEditor's MENU_SECTIONS and ReadonlyMenu's EXPORT_ITEMS),
   * which is the shape that lets one menu gain a format the other doesn't, or word the
   * same one differently.
   *
   * Plain text FIRST, because it's the one people reach for most: it's the format a
   * comment box actually accepts. Markdown below it is the same idea for somewhere
   * that renders it (Apple Notes, a README, a forum that takes it).
   *
   * The MARKS are one per FORMAT rather than four drawings of the idea "a file":
   * Txt01 and Csv01 are the set's own file marks, and Markdown and JSON, which the set
   * has no icon for, take the character each is actually written with — the # a
   * Markdown writer types for a heading, the braces a JSON file opens with.
   */
  const exportItems: { key: string; label: string; icon: IconNode; run: () => Promise<void> }[] = [
    { key: "text", label: "Copy as plain text", icon: Txt01Icon, run: copyPlainText },
    { key: "markdown", label: "Copy as Markdown", icon: HashIcon, run: copyMarkdown },
    { key: "csv", label: "Download CSV", icon: Csv01Icon, run: downloadCsv },
    { key: "json", label: "Download JSON", icon: ThirdBracketIcon, run: downloadJson },
  ];

  return { warmExporters, exportItems, copyPlainText, copyMarkdown, downloadCsv, downloadJson };
}
