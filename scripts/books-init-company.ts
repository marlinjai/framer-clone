// scripts/books-init-company.ts
//
// Operator CLI: prepare one company for the Books (Books plan P1.8). Writes the
// company setting (tax status, exemption note, sender block, payment terms) and
// the number counters through initBooksCompany, in one transaction. Safe to run
// again: an existing counter is never lowered or reformatted.
//
//   pnpm books:init-company \
//     --tenant-group <tenant group uuid> --tenant <company uuid> \
//     --sender <local JSON file> --tax-status small_business \
//     --counter 'invoice={n}:62' --counter 'credit_note=GS-{n}:1' --counter 'offer=ANG-{n}:1' \
//     [--payment-terms 14] [--exemption-note '...'] [--sender-file-only]
//
// The sender block: the company's legal name, VAT id and billing address come
// from the auth-brain company record (the admin machine API, GET
// /api/admin/machine/tenants), the rest (tax number, bank details, contact
// lines) from the local JSON file, which stays on the operator's machine and is
// never committed. Where both hold a field, auth-brain wins and the script says
// which field the file's value was ignored for (names only). `--sender-file-only`
// skips auth-brain and takes everything from the file.
//
// Environment (inject with Infisical, never a .env file):
//   COMMERCE_APP_DATABASE_URL  the low-privilege app role (the Books tables are
//                              ordinary tenant tables it reads and writes)
//   AUTH_BRAIN_URL             default https://auth.lumitra.co
//   AUTH_BRAIN_ADMIN_API_KEY   the auth-brain admin machine key (not needed with
//                              --sender-file-only)
//
// The logic lives in src/server/books/initCompanyCli.ts (no `server-only`
// modules, so it runs under tsx). Prints field names and counters, never sender
// values.

import { runBooksInitCompany } from '../src/server/books/initCompanyCli';

runBooksInitCompany(process.argv.slice(2), process.env, (line) => console.log(line)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
