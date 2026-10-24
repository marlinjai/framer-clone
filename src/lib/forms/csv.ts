// src/lib/forms/csv.ts
//
// The CSV export of form submissions. One row per submission, newest first:
// fixed columns (date, form, page, read) and then one column per field key in
// the order the fields first appear (a form that changed over time adds
// columns, a submission without a field leaves its cell empty).
//
// Spreadsheet safety: a cell that starts with = + - @, a tab or a carriage
// return is prefixed with an apostrophe, so a visitor cannot plant a formula
// that runs when the owner opens the file (CSV injection). Values are quoted
// per RFC 4180 and the file starts with a UTF-8 byte order mark so Excel reads
// umlauts correctly.

import type { StoredField } from './validation';

export interface CsvSubmission {
  createdAt: Date;
  formName: string;
  pagePath: string;
  readAt: Date | null;
  fields: StoredField[];
}

export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n;]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function fieldText(field: StoredField): string {
  if (typeof field.value === 'boolean') return field.value ? 'yes' : 'no';
  return field.value;
}

export function submissionsToCsv(rows: readonly CsvSubmission[]): string {
  const columns: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const f of row.fields) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      columns.push({ key: f.key, label: f.label || f.key });
    }
  }
  const header = ['Submitted at (UTC)', 'Form', 'Page', 'Read', ...columns.map((c) => c.label)];
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    const byKey = new Map(row.fields.map((f) => [f.key, f]));
    const cells = [
      row.createdAt.toISOString(),
      row.formName,
      row.pagePath,
      row.readAt ? 'yes' : 'no',
      ...columns.map((c) => {
        const f = byKey.get(c.key);
        return f ? fieldText(f) : '';
      }),
    ];
    lines.push(cells.map(csvCell).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
