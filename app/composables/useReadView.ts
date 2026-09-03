/**
 * Which half of a shared list is on screen — the gear, or the trip.
 *
 * A module-level ref rather than component state, for one structural reason: the control
 * and the content it governs are in DIFFERENT components. The switcher belongs to the
 * page's sticky header (SiteTopbar's second row, so it is always right under the toolbar
 * and always reachable), while the sections it swaps live in ReadonlyListView. Passing a
 * ref down through ReadTopbar and back up through two pages would thread state through
 * four files that otherwise have no opinion about it.
 *
 * DELIBERATELY not persisted, following the unit picker on these same pages: a share link
 * is usually opened once, by somebody who did not make the list, and a preference
 * remembered from a different list would decide what they see before they have looked at
 * anything.
 *
 * It DOES reset per list — see `resetReadView`. The value outliving a navigation would
 * mean opening a second share link on "Trip" because the first one was, which is the same
 * mistake as persisting it, only quieter.
 */
type ReadView = "gear" | "trip";

/**
 * useState, not a module-level ref, and that distinction is load-bearing HERE in a way
 * it isn't for the dialog singletons.
 *
 * A module ref is one variable shared by a long-running server process across every
 * request it handles. This one backs /s and /l — the SSR'd, indexable pages — so if
 * anything ever set it during render rather than after mount (seeding it from a query
 * param or a deep link is the obvious way in), one visitor's tab choice would decide
 * what the next visitor, or a crawler, was served. Nothing does that today; useState
 * makes it so nothing can, because the state is scoped to the request.
 *
 * Same shape as before — a Ref<ReadView> — so callers are unchanged.
 */
export function useReadView() {
  return useState<ReadView>("read-view", () => "gear");
}

/** Back to the gear. Called when a read page mounts, so one list's view never decides
 *  the next one's. "gear" is also the SSR state, which matters because /l is indexable
 *  and a crawler runs no JavaScript: whatever this starts as is what gets indexed.
 *  Only ever reached from onMounted, so the useState call above always has a client
 *  Nuxt context to resolve against. */
export function resetReadView() {
  useReadView().value = "gear";
}
