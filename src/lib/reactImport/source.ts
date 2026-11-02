// The way in: files to a result and a report. Worker and command line tool are thin
// shells around `importSource`. Nothing here evaluates source, and no flag changes that.
//
// A file from a stranger can overflow the parser or any walker, or expand past memory.
// So the input is measured first, depth is read from the tree, one budget runs across
// all layers, and every layer runs inside one catch. A hostile file costs a refusal
// with its reason, and `importSource` always returns.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Untrusted input".

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { extensionOf, isScript, isTooDeep, parseFile, type ParsedFile } from './atoms';
import { BudgetExceeded, IMPORT_LIMITS, createImportBudget, type BudgetLimit } from './budget';
import { convertFile } from './jsx';
import { Ledger } from './ledger';
import { DETAILS, buildReport, type DetailKey, type ImportReport } from './report';

export interface SourceInput {
  name: string;
  text: string;
}

export interface ImportOptions {
  /** False leaves source out of the report, for one a developer passes on. */
  excerpts?: boolean;
}

export interface ImportOutcome {
  /** The nodes to place. Absent when there is nothing to place. */
  root?: ComponentNode;
  report: ImportReport;
}

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/** Which input limit a set of files breaks. By size alone: nothing is parsed before this passes. */
function brokenLimit(files: readonly SourceInput[]): DetailKey | undefined {
  if (files.length > IMPORT_LIMITS.files) return 'tooManyFiles';
  let total = 0;
  for (const { text } of files) {
    // A UTF-16 unit is at least one byte, so this needs no encoding.
    if (text.length > IMPORT_LIMITS.bytesPerFile) return 'fileTooLarge';
    const bytes = utf8Length(text);
    if (bytes > IMPORT_LIMITS.bytesPerFile) return 'fileTooLarge';
    total += bytes;
  }
  return total > IMPORT_LIMITS.bytesInAll ? 'inputTooLarge' : undefined;
}

const BUDGET_DETAILS: Readonly<Record<BudgetLimit, DetailKey>> = {
  nodes: 'overNodes',
  evaluated: 'overEvaluated',
  unrolled: 'overUnrolled',
  'inlining-depth': 'overInlining',
  'recursive-component': 'recursive',
};

/** Why a conversion stopped. A `RangeError` is a stack that ran out, which depth limits should prevent and this still catches. */
function reasonFor(error: unknown): DetailKey {
  if (error instanceof BudgetExceeded) return BUDGET_DETAILS[error.limit];
  return error instanceof RangeError ? 'tooDeep' : 'failed';
}

/** Lists each file in the ledger. True when all of them can be converted. */
function openFiles(files: readonly SourceInput[], ledger: Ledger): { readable: boolean; entry?: ParsedFile } {
  let readable = true;
  let entry: ParsedFile | undefined;
  for (const { name, text } of files) {
    if (!isScript(name)) {
      const detail = extensionOf(name) === 'css' ? 'stylesheet' : 'notRead';
      ledger.openWhole(name, text, { kind: detail === 'stylesheet' ? 'css-rule' : 'statement', disposition: 'left', detail, next: ['rewrite'] });
      continue;
    }
    const parsed = parseFile(name, text);
    if (parsed.syntaxError !== undefined) {
      readable = false;
      ledger.openWhole(name, text, { kind: 'statement', disposition: 'left', detail: 'syntaxError', next: ['rewrite'] }, parsed.source, parsed.syntaxError);
    } else if (isTooDeep(parsed.source)) {
      readable = false;
      ledger.openWhole(name, text, { kind: 'cap', disposition: 'left', detail: 'tooDeep', next: ['rewrite'] }, parsed.source);
    } else {
      ledger.open(parsed);
      entry ??= parsed;
    }
  }
  return { readable, entry };
}

/** The last resort: nothing about the conversion could be told, and this line still can be. */
const failedReport = (): ImportReport => ({
  lines: [{ file: '', line: 1, column: 1, endLine: 1, atoms: [], kind: 'cap', disposition: 'left', detail: DETAILS.failed, next: ['rewrite'] }],
  counts: { converted: 0, adapted: 0, rebuilt: 0, left: 1 },
  verdict: 'not-imported',
});

export function importSource(files: readonly SourceInput[], options: ImportOptions = {}): ImportOutcome {
  const ledger = new Ledger(options.excerpts ?? true);
  try {
    let root: ComponentNode | undefined;
    const broken = brokenLimit(files);
    if (broken) ledger.refuse(broken);
    else {
      const { readable, entry } = openFiles(files, ledger);
      if (!entry && readable) ledger.refuse('nothingToPlace', 'statement');
      if (entry && readable) root = convertFile(entry, ledger, createImportBudget());
    }
    return { ...(root ? { root } : {}), report: buildReport(ledger.close(), root !== undefined) };
  } catch (error) {
    try {
      ledger.refuse(reasonFor(error));
      return { report: buildReport(ledger.close(), false) };
    } catch {
      return { report: failedReport() };
    }
  }
}
