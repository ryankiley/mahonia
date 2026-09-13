/** A shared vocabulary for the editor's native datalist, fetched on first focus. */
export function useGearTypes() {
  const names = ref<string[] | null>(null);
  let loading = false;

  async function load() {
    if (names.value !== null || loading) return;
    loading = true;
    try {
      names.value = await $fetch<string[]>("/api/catalog/types", { retry: 0 });
    } catch {
      // Suggestions are optional. Keep free text working and retry on the next focus.
    } finally {
      loading = false;
    }
  }

  return { names, load };
}
