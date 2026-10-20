// scripts/books-import.ts
//
// Operator CLI: import the company's historical invoices into its Books as
// issued documents with `source = 'import'`, each with its original PDF stored
// as the document of record and never re-rendered (Books plan, "Historical
// import build notes (2026-10-20)").
//
//   pnpm books:import \
//     --tenant-group <tenant group uuid> --tenant <company uuid> \
//     --input <private JSON file> --files-dir <directory the JSON's file paths are relative to> \
//     [--dry-run]
//
// Run `pnpm books:init-company` first: the invoice counter must exist and lie
// above every imported number (it is never moved here). `--dry-run` validates
// the input, reads and hashes every original, checks the counter and that the
// contacts database answers, and prints the plan; it writes nothing.
//
// Safe to run again: a number already imported with the same file is reported
// as "already imported"; the same number with a different file, or a number
// the editor issued, is an error for that number and nothing is overwritten.
// An entry without its file, recipient, sender or lines is skipped with the
// reason and imported by a later run once the input is complete. Each invoice
// is written in its own transaction.
//
// Environment (inject with Infisical, never a .env file):
//   COMMERCE_APP_DATABASE_URL  the low-privilege app role
//   CONTACTS_DATABASE_URL      the shared contacts database (recipients are
//                              found or created there, application name `books`)
//
// The input and the originals stay on the operator's machine and are never
// committed. The output carries invoice numbers, issue dates, totals, statuses,
// counts and yearly sums only: never names, addresses, line texts, file names
// or connection strings. Exit code 1 when any number ended in an error, or an
// already imported number's stored total or date differs from the input.
//
// The logic lives in src/server/books/importCli.ts (no `server-only` modules,
// so it runs under tsx).

import { exitCodeFor, runBooksImport, scriptErrorLine } from '../src/server/books/importCli';

runBooksImport(process.argv.slice(2), process.env, (line) => console.log(line))
  .then((report) => {
    process.exitCode = exitCodeFor(report);
  })
  .catch((err) => {
    console.error(scriptErrorLine(err));
    process.exitCode = 1;
  });
