// src/lib/books/searchKey.ts
//
// The one fold the product and service list compares names and searches with
// (migration 015_books_products, guarantee 3): lower case, accents removed
// ("Beratúng" -> "beratung"), compatibility forms decomposed ("ﬁ" -> "fi"),
// "ß" written "ss", whitespace collapsed to one space and trimmed. The
// repository stores it as `name_key` (the unique key among live items) and
// `search_text` (name and description, what the search matches), and folds the
// typed search the same way, so the database needs no accent extension.
// Client-safe: no server imports.

/** The comparison form of a text (see the file header). */
export function foldKey(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The words of a typed search, folded; an empty search has none. */
export function searchWords(query: string): string[] {
  const folded = foldKey(query);
  return folded === '' ? [] : folded.split(' ');
}
