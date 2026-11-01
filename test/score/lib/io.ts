// Where a run writes. `.out` is wiped at the start of every run (run.ts), so a
// result can never come from an earlier one.

import fs from 'node:fs';
import path from 'node:path';

export const OUT_DIR = path.resolve(process.cwd(), 'test/score/.out');
export const REPORT_DIR = path.resolve(process.cwd(), 'docs/primitives-score');

export function writeOut(name: string, data: unknown): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
}

export function readOut<T>(name: string): T {
  const file = path.join(OUT_DIR, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`the ${name} probe wrote no result (${file})`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}
