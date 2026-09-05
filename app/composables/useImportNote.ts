// A one-line note the import hands to the editor it navigates to ("18 of 25 rows
// matched the catalog."), shown as a toast once that list is on screen. In-memory app
// state, like useResumed: the modal's own toast would die with the page it's on.
export const useImportNote = () => useState<string | null>("import-note", () => null);
