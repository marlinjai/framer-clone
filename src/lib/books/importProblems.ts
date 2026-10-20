// src/lib/books/importProblems.ts
//
// What the review table of the upload import says about a named problem
// (src/server/books/upload/validate.ts). The server sends codes, field paths
// and counts, never values; this turns them into a sentence a person can act
// on. An unknown code still shows (as itself), never disappears.

import type { ImportProblem } from './api';

const TEXT: Record<string, string> = {
  not_read: 'Not read yet.',
  'extraction_failed:refused': 'The AI declined to read this file. Check that it is an invoice, or fill in the fields yourself.',
  'extraction_failed:invalid_output': 'The AI could not read this file into an invoice. Read it again, or fill in the fields yourself.',
  'extraction_failed:max_tokens': 'This invoice is too long to read in one go. Fill in the fields yourself.',
  'extraction_failed:error': 'Reading failed (the AI service did not answer). Read it again.',
  number_missing: 'The invoice number is missing.',
  recipient_missing: 'The recipient is missing.',
  sender_missing: 'The sender is missing.',
  lines_missing: 'The invoice has no billable line.',
  issue_date_invalid: 'The invoice date is not a date.',
  issue_date_in_future: 'The invoice date lies in the future.',
  currency_invalid: 'The currency is not a currency code (EUR, CHF).',
  tax_treatment_unsupported: 'The tax treatment is not one the Books know (section 19, regular VAT, reverse charge).',
  gross_priced_lines: 'The line prices include VAT. Invoices with gross line prices cannot be imported yet; enter the net amounts per line.',
  tax_on_untaxed_invoice: 'The invoice charges VAT, but its tax treatment says it does not.',
  total_invalid: 'The total is missing or not an amount.',
  recipient_country_unknown: 'The recipient country is unknown.',
  sender_country_unknown: 'The sender country is unknown.',
  line_text_missing: 'A line has no description.',
  line_text_too_long: 'A line description is longer than 4000 characters.',
  line_quantity_invalid: 'A line quantity is not usable.',
  line_amount_invalid: 'A line amount is not usable (more than two decimals, or out of range).',
  line_sign_mismatch: 'A line has a price and a total of opposite signs.',
  line_tax_rate_missing: 'A line has no VAT rate, and the invoice prints more than one.',
  line_tax_rate_unsupported: 'A line carries a VAT rate that is not a German rate (19, 16, 7, 5 or 0 %).',
  lines_do_not_sum_to_total: 'The lines (net plus VAT) do not add up to the total.',
  invalid_field: 'This field is not valid.',
  number_staged_twice: 'Another file in this table has the same invoice number.',
  number_taken: 'An invoice with this number is already in the Books.',
  same_original_imported: 'This exact file is already imported under another number.',
  already_imported: 'This invoice is already imported. Discard the row.',
  recipient_ambiguous: 'More than one contact carries this recipient name. Make the name unique in the contacts first.',
  counter_missing: 'The Books are not set up for this company yet (no invoice counter).',
  contacts_unavailable: 'The contacts database could not be read. Check again in a moment.',
  // Warnings: imported as printed, check against the PDF.
  line_not_quantity_times_price: 'Line total is not quantity times price (kept as printed).',
  line_tax_not_rate_times_net: 'Line VAT is not its rate times its net (kept as printed).',
  line_price_derived: 'Unit price taken from the line total (none printed).',
  line_tax_derived: 'Line VAT calculated from the rate and the printed VAT summary.',
  discount_unparsed: 'A printed discount could not be read (the line total is kept).',
  issue_date_out_of_number_order: 'The date does not fit between the neighbouring invoice numbers. Check day and month.',
  sender_address_missing: 'The sender address is not printed in full.',
  recipient_address_incomplete: 'The recipient address is not printed in full.',
  recipient_country_assumed: 'The recipient country is not printed; Germany is assumed.',
  tax_note_missing: 'The tax note (section 19 or reverse charge) is not printed.',
  sender_from_company: 'Sender fields not on the PDF are taken from the company settings.',
  counter_raised: 'Importing raises the invoice counter.',
  number_jump: 'This number jumps far ahead. Check it against the PDF, then confirm it if it is right.',
  unsure_medium: 'The AI was not sure about this field.',
  unsure_low: 'The AI could hardly read this field.',
};

/** The sentence for one problem; counts are added where they say something. */
export function problemText(p: ImportProblem): string {
  const base = TEXT[p.code] ?? (p.code.startsWith('import_failed:') ? `The import failed (${p.code.slice(14)}). Nothing was imported; try again.` : p.code);
  if (p.code === 'counter_raised' && p.count !== null) {
    return `Your next invoice number will become ${p.count}. It cannot be lowered later.`;
  }
  if (p.code === 'number_jump' && p.count !== null) {
    return `This number is more than 50 above ${p.count} (the next invoice number, or the highest of the other invoices here). Check it against the PDF; if it is right, confirm it.`;
  }
  if (p.count !== null && p.count > 1 && p.code.startsWith('line')) return `${base} (${p.count} lines)`;
  return base;
}

const PATH_LABELS: Record<string, string> = {
  number: 'Number',
  issueDate: 'Date',
  serviceDate: 'Service date',
  servicePeriod: 'Service period',
  total: 'Total',
  currency: 'Currency',
  taxTreatment: 'Tax',
  taxNote: 'Tax note',
  recipientVatId: 'Recipient VAT id',
  paymentTerms: 'Payment terms',
};

/** A short label for a field path ("lines.2.lineTotal" -> "Line 3, total"). */
export function pathLabel(path: string | null): string | null {
  if (!path) return null;
  const line = /^lines\.(\d+)\.?(.*)$/.exec(path);
  if (line) return `Line ${Number(line[1]) + 1}${line[2] ? `, ${line[2]}` : ''}`;
  const [head, rest] = path.split(/\.(.+)/);
  if (head === 'recipient' || head === 'sender') return `${head === 'recipient' ? 'Recipient' : 'Sender'}${rest ? ` ${rest}` : ''}`;
  return PATH_LABELS[path] ?? path;
}
