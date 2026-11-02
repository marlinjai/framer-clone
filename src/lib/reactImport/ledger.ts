// The ledger: every atom is opened as `left`, and a layer has to claim one to change
// that, so nothing vanishes unreported. That says nothing about whether a claim is
// right, which is what the score's Honesty measure is for.
//
// The contract is docs/plans/2026-11-02-react-import.md, "The ledger".

import ts from 'typescript';
import { collectAtoms, walk, type Atom, type ParsedFile } from './atoms';
import { IMPORT_LIMITS } from './budget';
import { DETAILS, type DetailKey, type Disposition, type ImportLine, type LineKind, type NextAction } from './report';

const EXCERPT_LENGTH = 120;

export interface Claim {
  kind: LineKind;
  disposition: Disposition;
  detail: DetailKey;
  next?: NextAction[];
  nodeKey?: string;
  invisible?: true;
}

interface OpenFile {
  name: string;
  source: ts.SourceFile | undefined;
  text: string;
  atoms: Atom[];
  byNode: Map<ts.Node, Atom>;
  claimed: Set<number>;
}

/** Enough source to fill an excerpt after collapsing whitespace, without copying a whole file. */
const excerptOf = (text: string, start: number, end: number): string =>
  text.slice(start, Math.min(end, start + EXCERPT_LENGTH * 8)).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_LENGTH);

/** What an unclaimed construct is called in the report. */
function kindOfSyntax(kind: ts.SyntaxKind | undefined): LineKind {
  if (kind === undefined) return 'statement';
  if (kind === ts.SyntaxKind.ImportDeclaration || kind === ts.SyntaxKind.ImportEqualsDeclaration) return 'import';
  if (kind === ts.SyntaxKind.JsxElement || kind === ts.SyntaxKind.JsxSelfClosingElement) return 'element';
  if (kind === ts.SyntaxKind.JsxAttribute) return 'attribute';
  if (kind === ts.SyntaxKind.JsxSpreadAttribute) return 'spread';
  const declaration = kind === ts.SyntaxKind.FunctionDeclaration || kind === ts.SyntaxKind.ClassDeclaration
    || kind === ts.SyntaxKind.InterfaceDeclaration || kind === ts.SyntaxKind.TypeAliasDeclaration
    || kind === ts.SyntaxKind.VariableDeclaration;
  const statement = kind >= ts.SyntaxKind.FirstStatement && kind <= ts.SyntaxKind.LastStatement;
  return declaration || statement ? 'statement' : 'expression';
}

export class Ledger {
  private readonly files: OpenFile[] = [];
  private readonly lines: ImportLine[] = [];
  /** Nodes walked by a subtree claim: inlining meets the same one again, and a walk is not free. */
  private readonly walked = new Set<ts.Node>();

  constructor(private readonly excerpts: boolean = true) {}

  /** Opens a parsed file: all of it `left` until claimed. */
  open(file: ParsedFile): void {
    const { atoms, byNode } = collectAtoms(file, this.files.length);
    this.files.push({ name: file.name, source: file.source, text: file.source.text, atoms, byNode, claimed: new Set() });
  }

  /** Opens a file that is not converted: one atom over all of it, and the line that says why. */
  openWhole(name: string, text: string, claim: Claim, source?: ts.SourceFile, at = 0): void {
    const atom: Atom = { id: `${this.files.length}:0`, index: 0, start: at, end: text.length };
    const file: OpenFile = { name, source, text, atoms: [atom], byNode: new Map(), claimed: new Set() };
    this.files.push(file);
    this.claimAtoms(file, [atom], claim);
  }

  /** A claim over exactly these nodes. What sits inside them stays open: one broad line may not cover it. */
  claim(source: ts.SourceFile, nodes: readonly ts.Node[], claim: Claim): void {
    const file = this.fileOf(source);
    this.claimAtoms(file, nodes.flatMap((node) => file.byNode.get(node) ?? []), claim);
  }

  /** A claim over a node and all it holds, for what is wholly read or wholly refused. */
  claimSubtree(source: ts.SourceFile, node: ts.Node, claim: Claim): void {
    if (this.walked.has(node)) return;
    this.walked.add(node);
    const file = this.fileOf(source);
    const atoms: Atom[] = [];
    walk(node, undefined, (each) => {
      const atom = file.byNode.get(each);
      if (atom) atoms.push(atom);
      return { next: undefined };
    });
    this.claimAtoms(file, atoms, claim);
  }

  /** A line about the import as a whole, such as why it stopped. It claims nothing, so all that is open stays open. */
  refuse(detail: DetailKey, kind: LineKind = 'cap', next: NextAction[] = ['rewrite'], disposition: Disposition = 'left'): void {
    this.lines.push({ file: this.files[0]?.name ?? '', line: 1, column: 1, endLine: 1, atoms: [], kind, disposition, detail: DETAILS[detail], next });
  }

  /** Every line: the claimed ones, then one per stretch of unclaimed source, so the ledger is total. */
  close(): ImportLine[] {
    for (const file of this.files) {
      // Parents come first, so a child of an open atom joins its parent's line.
      const stretches = new Map<number, Atom[]>();
      const stretchOf = new Map<number, number>();
      for (const atom of file.atoms) {
        if (file.claimed.has(atom.index)) continue;
        const stretch = (atom.parent === undefined ? undefined : stretchOf.get(atom.parent)) ?? atom.index;
        stretchOf.set(atom.index, stretch);
        const atoms = stretches.get(stretch);
        if (atoms) atoms.push(atom);
        else stretches.set(stretch, [atom]);
      }
      for (const atoms of stretches.values()) {
        this.pushLine(file, atoms, { kind: kindOfSyntax(atoms[0].syntaxKind), disposition: 'left', detail: 'left', next: ['rewrite'] });
      }
    }
    return this.bounded();
  }

  /** A hostile file can be a million statements. What does not fit is one line, so nothing is dropped. */
  private bounded(): ImportLine[] {
    if (this.lines.length <= IMPORT_LIMITS.reportLines) return this.lines;
    const isLoose = (line: ImportLine) => line.disposition === 'left' && line.nodeKey === undefined && line.kind !== 'cap';
    const fixed = this.lines.filter((line) => !isLoose(line));
    const loose = this.lines.filter(isLoose);
    const room = Math.max(0, IMPORT_LIMITS.reportLines - fixed.length - 1);
    const rest = loose.slice(room);
    // Every other line came out of the budget, which is what bounds those.
    if (rest.length === 0) return this.lines;
    const { file, line, column, endLine } = rest[0];
    const last: ImportLine = { file, line, column, endLine, atoms: rest.flatMap((each) => each.atoms), kind: 'cap', disposition: 'left', detail: DETAILS.overLines, next: ['rewrite'] };
    return [...fixed, ...loose.slice(0, room), last];
  }

  private fileOf(source: ts.SourceFile): OpenFile {
    const file = this.files.find((each) => each.source === source);
    if (!file) throw new Error('a claim on a file the ledger never opened');
    return file;
  }

  /** The first claim on an atom stands: a component inlined twice is one construct of the source. */
  private claimAtoms(file: OpenFile, atoms: readonly Atom[], claim: Claim): void {
    const open = atoms.filter((atom) => !file.claimed.has(atom.index));
    if (open.length === 0) return;
    for (const atom of open) file.claimed.add(atom.index);
    this.pushLine(file, open, claim);
  }

  private pushLine(file: OpenFile, atoms: readonly Atom[], claim: Claim): void {
    let start = atoms[0].start;
    let end = atoms[0].end;
    for (const atom of atoms) {
      start = Math.min(start, atom.start);
      end = Math.max(end, atom.end);
    }
    const from = file.source?.getLineAndCharacterOfPosition(start) ?? { line: 0, character: 0 };
    const to = file.source?.getLineAndCharacterOfPosition(end) ?? from;
    this.lines.push({
      file: file.name,
      line: from.line + 1,
      column: from.character + 1,
      endLine: to.line + 1,
      ...(this.excerpts ? { excerpt: excerptOf(file.text, start, end) } : {}),
      atoms: atoms.map((atom) => atom.id),
      kind: claim.kind,
      disposition: claim.disposition,
      detail: DETAILS[claim.detail],
      next: claim.next ?? [],
      ...(claim.nodeKey === undefined ? {} : { nodeKey: claim.nodeKey }),
      ...(claim.invisible ? { invisible: true as const } : {}),
    });
  }
}
