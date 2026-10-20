// src/server/books/http/dependencies.ts
//
// The outside services a Books request talks to, in one place: the recipient
// directory issue reads the frozen snapshot from, and the contact book the
// editor searches and labels with. Both default to the shared contacts database
// (opened lazily on first use, so importing a route needs no database). Route
// tests replace this module with fakes; production never does.

import { defaultContactBook, type ContactBook } from '../contactBook';
import { contactsRecipientDirectory, type RecipientDirectory } from '../recipients';

export interface BooksDependencies {
  recipients: RecipientDirectory;
  contactBook: ContactBook;
}

let recipients: RecipientDirectory | undefined;

export function booksDependencies(): BooksDependencies {
  recipients ??= contactsRecipientDirectory();
  return { recipients, contactBook: defaultContactBook() };
}
