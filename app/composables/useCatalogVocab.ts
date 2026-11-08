/**
 * A catalog vocabulary (its brands, its gear types) for My Gear's edit dialog, fetched
 * on the field's first focus. useGearTypes does the same job for the list editor, and is
 * deliberately not reused here: it lives in the editor's first load, and importing an
 * editor module from /gear moves it into a chunk the two routes share, which the editor
 * pays for on every visit (wiki: sharing an editor module with another route costs the
 * first load). Fifteen lines twice is the cheaper side of that trade.
 */
export function useCatalogVocab(path: "/api/catalog/brands" | "/api/catalog/types") {
  const names = ref<string[] | null>(null);
  let loading = false;
  async function load() {
    if (names.value !== null || loading) return;
    loading = true;
    try {
      names.value = await $fetch<string[]>(path, { retry: 0 });
    } catch {
      // Suggestions are optional. Keep free text working and retry on the next focus.
    } finally {
      loading = false;
    }
  }
  return { names, load };
}
