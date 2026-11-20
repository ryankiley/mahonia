// A research row's quote is written for the audit: verbatim from the cited page,
// which for a spec table means "M | 3.8 oz | 108 g" and for a scraped page can mean
// a stray tag. The product page shows the words, so it reads them through this one
// fold — display only; the research file keeps what the page actually said.

const TAG = /<\/?[a-z][^>]*>/gi;

export function displayQuote(raw: string): string {
  return raw
    .replace(TAG, " ")
    // a spec table's column bars become the app's own separator
    .replace(/\s*\|\s*/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
}
