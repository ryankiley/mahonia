// DOM gestures the component suites share. Kept apart from helpers/itemRow, which
// imports ItemRow.vue: a suite that only types into a field shouldn't load the row.

/** Type into a field the way a person does: focus it, change its value, commit nothing. */
export function typeInto(el: HTMLInputElement, value: string): void {
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
