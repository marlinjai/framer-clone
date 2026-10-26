// src/lib/books/searchKey.ts
//
// The one fold names and searches are compared with: lower case, accents
// removed ("Beratúng" -> "beratung"), compatibility forms decomposed
// ("ﬁ" -> "fi"), "ß" written "ss", whitespace collapsed to one space and
// trimmed. The catalogue stores it as `product.search_text` (title and
// description; 020_catalogue_company, as 015_books_products did for the old
// Books list), and the line picker's search (repository/catalogue.ts) folds the
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
