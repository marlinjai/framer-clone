// What the import score writes for the report, apart so `report.ts` reads types only.

import type { Disposition, Verdict } from '@/lib/reactImport/report';
import type { ThemeId } from './themes';

export type ImportCheck = 'screenshot' | 'computed-styles' | 'accessibility-tree' | 'interaction';

export interface ImportFailure {
  viewport: string;
  state: string;
  check: ImportCheck;
  detail: string;
}

export interface ImportRun {
  fixture: string;
  group: 'repo-component' | 'hand-written';
  theme: ThemeId;
  verdict: Verdict;
  /** `readBundle`'s own verdict, which a bundle can make worse and never better. */
  readVerdict: Verdict;
  /** Lines by disposition, and the atoms they hold. */
  lines: Record<Disposition, number>;
  atoms: Record<Disposition, number> & { total: number };
  /** Atoms converted or adapted, over all atoms, without AI. */
  coverage: number;
  /** The first lines that block placing, by detail, for the report. */
  blocking: string[];
  conservation: { pass: boolean; constructs: number; problems: string[] };
  parity: { pass: boolean; checks: Record<ImportCheck, { pass: number; total: number }>; failures: ImportFailure[] };
  /** Differences no line names, on a fixture whose verdict claims an import. Honesty is these being none. */
  honesty: {
    pass: boolean;
    unnamed: string[];
    /** Differences a line names, by element and property, so the excuse table can be read against them. */
    excused: string[];
  };
  waitsOn?: string;
}

export interface ForgedCase {
  fixture: string;
  theme: ThemeId;
  forgery: string;
  pass: boolean;
  detail: string;
}

export interface MutationCase {
  snippet: string;
  site: string;
  line: number;
  named: boolean;
  conserved: boolean;
}

export interface ImportScoreOut {
  runs: ImportRun[];
  forged: ForgedCase[];
  mutation: MutationCase[];
  foreignThemeDistinct: { pass: boolean; same: string[] };
  /** The measure tested: tokens removed from a real import, report unchanged, must show as differences no line names. */
  honestySees: { pass: boolean; planted: string[]; unnamed: number };
  excuses: { detail: string; reason: string }[];
}
