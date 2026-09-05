// The share code of the list the bare address just resumed, set by /
// (app/pages/index.vue) and read by the editor to aim the switcher's hint at the
// list you were dropped into. In-memory app state: it must not survive a reload of
// the list's own URL, which is not a resume.
export const useResumed = () => useState<string | null>("resumed-list", () => null);
