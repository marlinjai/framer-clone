// Conservation: nothing of the source vanishes unreported. An independent walker, which
// shares no code with `src/lib/reactImport/atoms.ts`, lists every construct of each file
// with its exact range, and the report must account for each one exactly once, on a line
// whose range holds it. So one broad line cannot cover what sits inside it.
//
// This shows that nothing vanished. It says nothing about whether a claim is right: that
// is Honesty's question, and it is asked in a browser.

import ts from 'typescript';
import type { AtomRecord } from '@/lib/reactImport/ledger';
import type { ImportOutcome, SourceInput } from '@/lib/reactImport/source';

/** Kinds that are no construct of their own, stated here again, on purpose, rather than imported. */
const HOLDERS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.SourceFile, ts.SyntaxKind.EndOfFileToken, ts.SyntaxKind.VariableStatement, ts.SyntaxKind.VariableDeclarationList,
  ts.SyntaxKind.JsxOpeningElement, ts.SyntaxKind.JsxClosingElement, ts.SyntaxKind.JsxAttributes, ts.SyntaxKind.JsxOpeningFragment,
  ts.SyntaxKind.JsxClosingFragment,
]);
const KEYWORD_MODIFIERS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AbstractKeyword, ts.SyntaxKind.AccessorKeyword, ts.SyntaxKind.AsyncKeyword, ts.SyntaxKind.ConstKeyword, ts.SyntaxKind.DeclareKeyword,
  ts.SyntaxKind.DefaultKeyword, ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.InKeyword, ts.SyntaxKind.OutKeyword, ts.SyntaxKind.OverrideKeyword,
  ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.StaticKeyword,
]);

const isConstruct = (node: ts.Node): boolean =>
  !(node.kind >= ts.SyntaxKind.FirstPunctuation && node.kind <= ts.SyntaxKind.LastPunctuation)
  && !HOLDERS.has(node.kind) && !KEYWORD_MODIFIERS.has(node.kind)
  && !(ts.isJsxText(node) && node.containsOnlyTriviaWhiteSpaces);

interface Construct {
  file: string;
  kind?: ts.SyntaxKind;
  start: number;
  end: number;
}

const SCRIPT = /\.(?:tsx|ts|jsx|js|mjs)$/i;
const CONFIG = /(?:^|\/)tailwind\.config\.[cm]?[jt]s$/i;

/** Every construct of the files, as this walker reads them. A file that is not parsed is one construct. */
function constructsOf(files: readonly SourceInput[], parsed: ReadonlySet<string>): Construct[] {
  const out: Construct[] = [];
  for (const { name, text } of files) {
    if (!parsed.has(name)) {
      out.push({ file: name, start: 0, end: text.length });
      continue;
    }
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (isConstruct(node)) out.push({ file: name, kind: node.kind, start: node.getStart(source), end: node.end });
      // A closing tag holds only the name its opening tag holds.
      if (!ts.isJsxClosingElement(node)) ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

export interface ConservationResult {
  pass: boolean;
  constructs: number;
  /** What went wrong, at most a handful, with `file:line`. */
  problems: string[];
}

const lineAt = (text: string, offset: number): number => text.slice(0, offset).split('\n').length;

/** Whether every construct is in the report, once, on a line that holds it. */
export function checkConservation(files: readonly SourceInput[], outcome: ImportOutcome): ConservationResult {
  const problems: string[] = [];
  const atoms = outcome.atoms ?? [];
  const texts = new Map(files.map((file) => [file.name, file.text]));
  // Scripts the importer parsed are read construct by construct; the rest, a config and sheets, whole.
  const parsed = new Set(files.filter(({ name }) => SCRIPT.test(name) && !CONFIG.test(name)).map(({ name }) => name));
  const constructs = constructsOf(files, parsed);
  const key = (each: Construct | AtomRecord) => `${each.file}:${each.start}:${each.end}:${('syntaxKind' in each ? each.syntaxKind : (each as Construct).kind) ?? 'whole'}`;
  const byKey = new Map<string, AtomRecord[]>();
  for (const atom of atoms) byKey.set(key(atom), [...(byKey.get(key(atom)) ?? []), atom]);
  const where = (each: Construct) => `${each.file}:${lineAt(texts.get(each.file) ?? '', each.start)}`;

  const expected = new Set<string>();
  for (const construct of constructs) {
    const found = byKey.get(key(construct));
    expected.add(key(construct));
    if (!found || found.length === 0) problems.push(`${where(construct)}: ${construct.kind === undefined ? 'the file' : ts.SyntaxKind[construct.kind]} is no atom`);
  }
  for (const atom of atoms) if (!expected.has(key(atom))) problems.push(`${where(atom)}: an atom this walker finds no construct for`);

  const lineOf = new Map<string, number>();
  outcome.report.lines.forEach((line, index) => {
    for (const id of line.atoms) {
      if (lineOf.has(id)) problems.push(`${line.file}:${line.line}: atom ${id} is on two lines`);
      lineOf.set(id, index);
    }
  });
  for (const atom of atoms) {
    const index = lineOf.get(atom.id);
    if (index === undefined) {
      problems.push(`${where(atom)}: atom ${atom.id} is on no line`);
      continue;
    }
    const line = outcome.report.lines[index];
    const text = texts.get(atom.file) ?? '';
    const from = lineAt(text, atom.start);
    const to = lineAt(text, atom.end);
    if (line.file !== atom.file || line.line > from || line.endLine < to) problems.push(`${where(atom)}: its line ${line.file}:${line.line}-${line.endLine} does not hold it`);
  }
  return { pass: problems.length === 0, constructs: constructs.length, problems: problems.slice(0, 8) };
}
