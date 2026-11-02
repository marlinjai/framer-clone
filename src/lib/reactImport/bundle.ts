// The one door into a project: the import bundle. A worker's result and an uploaded file
// both come through `readBundle`, because a bundle can be forged and no layer is trusted
// for having run. It takes nothing on the bundle's word: every node goes through the
// checks a stored page meets, ids are rewritten so nothing collides with the project or
// points into it, secret-shaped text is removed, and the verdict is recomputed from what
// is left. The bundle's own report is a claim, kept apart from what this found.
//
// Format 1 holds nodes to place. Components, bindings and behaviour arrive with the
// slices that produce them (`import-props`, `import-entries`, `import-hooks`), and until
// then a bundle holding them has them removed, with a line, never trusted.
//
// The contract is docs/plans/2026-11-02-react-import.md, "The import bundle".

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { contentBelow, isDroppedId, isDroppedProp, isBlockedTag, safeInlineStyle, type ForeignContent } from '@/lib/renderer/blockedNodes';
import { isIdReference } from '@/lib/renderer/idRefs';
import { isPlatformAttribute } from '@/lib/renderer/platformAttributes';
import { isRenderedAttribute } from '@/lib/renderer/renderVocabulary';
import { TEXT_NODE_TYPE } from '@/lib/renderer/textNode';
import { isStyleMap } from '@/lib/responsive/responsiveCss';
import { readRules } from '@/lib/rules/rules';
import { IMPORT_LIMITS } from './budget';
import { FORM_LOGIC_NAMES, KEYED_NAMES, PLAIN_TAG, fetchesElsewhere } from './jsx';
import { DETAILS, verdictOf, type DetailKey, type Disposition, type ImportLine, type ImportReport, type LineKind, type NextAction, type Verdict } from './report';
import { findSecret } from './secrets';
import type { ImportOptions, ImportOutcome, SourceInput } from './source';
import { checkNormal } from './tailwind';

export const BUNDLE_FORMAT = 1;

export const BUNDLE_LIMITS = {
  /** Of the file as text, before it is parsed. */
  bytes: 8 * 1024 * 1024,
  /** Of the JSON, before it is parsed: a node is two levels, so this leaves room for the output depth and its props. */
  jsonDepth: 1_024,
  sourceHash: 128,
  file: 512,
  excerpt: 120,
  atoms: 100_000,
} as const;

export interface ImportBundle {
  format: typeof BUNDLE_FORMAT;
  /** Keys derived state: changing any input discards what was derived from it. */
  sourceHash: string;
  nodes?: ComponentNode;
  /** Not read in format 1. */
  definitions?: unknown[];
  report: ImportReport;
}

export interface ProjectContext {
  /** Every node id the project holds, so a bundle's never collides with one. */
  ids: ReadonlySet<string>;
}

export interface ReadBundle {
  /** The nodes to place, checked, with ids of their own. */
  nodes?: ComponentNode;
  /** The bundle's report as it states it, made readable. A claim: an uploaded one is labelled "stated by the file, not verified". */
  stated: ImportReport;
  /** What this reader found itself. These are facts. */
  found: ImportLine[];
  /** From the stated lines and the found ones together, so a bundle can make its verdict worse and never better. */
  verdict: Verdict;
  /** A bundle node id to the id it now has. */
  ids: Map<string, string>;
}

const DISPOSITIONS: ReadonlySet<string> = new Set<Disposition>(['converted', 'adapted', 'rebuilt', 'left']);
const NEXT_ACTIONS: ReadonlySet<string> = new Set<NextAction>(['rewrite', 'accept', 'add-tokens', 'add-entry', 'rebuild-with-ai', 'custom-code', 'use-system-dark']);
const LINE_KINDS: ReadonlySet<string> = new Set<LineKind>([
  'element', 'attribute', 'spread', 'expression', 'statement', 'import', 'class', 'class-unknown', 'css-rule', 'token', 'hook', 'handler', 'loop',
  'condition', 'refused-rule', 'refused-tag', 'refused-attribute', 'external-address', 'taint', 'secret', 'cap', 'unknown-component', 'unknown-package',
]);
const KNOWN_DETAILS: ReadonlySet<string> = new Set(Object.values(DETAILS));

const NODE_FIELDS: ReadonlySet<string> = new Set(['id', 'type', 'props', 'children']);
/** A class the import keeps because its own selectors read it. Nothing else may be stored: the editor's utilities are in scope on the canvas and the page. */
const KEPT_CLASS = /^u-c-[A-Za-z0-9_-]+$/;
const STYLE_MAP_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const SOURCE_HASH = /^[0-9a-f]{16,128}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

// ---------- making one ----------

const encoder = new TextEncoder();

/** A digest of every input that decides the result, so reselecting the same input keeps what was derived from it. */
export async function sourceHashOf(files: readonly SourceInput[], options: ImportOptions = {}): Promise<string> {
  const decided = { files: files.map(({ name, text }) => [name, text]), breakpoints: options.breakpoints ?? null, systemDark: options.systemDark ?? false };
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(decided)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A worker's result as a bundle. Excerpts are source, so `excerpts: false` leaves them out, for a bundle passed on. The atom table never travels. */
export async function createBundle(files: readonly SourceInput[], outcome: ImportOutcome, options: ImportOptions = {}): Promise<ImportBundle> {
  const keepExcerpts = options.excerpts ?? true;
  const lines = outcome.report.lines.map((line) => {
    if (keepExcerpts || line.excerpt === undefined) return line;
    const without: ImportLine = { ...line };
    delete without.excerpt;
    return without;
  });
  return {
    format: BUNDLE_FORMAT,
    sourceHash: await sourceHashOf(files, options),
    ...(outcome.root ? { nodes: outcome.root } : {}),
    report: { ...outcome.report, lines },
  };
}

// ---------- reading one ----------

class Unreadable extends Error {
  constructor(readonly detail: DetailKey) {
    super(detail);
  }
}

/** How deep a JSON text nests, in one pass and without parsing it, stopping at the limit. */
function jsonTooDeep(text: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 92) i += 1;
      else if (ch === 34) inString = false;
    } else if (ch === 34) inString = true;
    else if (ch === 123 || ch === 91) {
      depth += 1;
      if (depth > BUNDLE_LIMITS.jsonDepth) return true;
    } else if (ch === 125 || ch === 93) depth -= 1;
  }
  return false;
}

/** The same for a value that arrived parsed, as from a worker: depth, and no object reached twice. */
function valueTooDeep(root: unknown): boolean {
  const seen = new Set<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };
    if (typeof value !== 'object' || value === null) continue;
    if (depth > BUNDLE_LIMITS.jsonDepth || seen.has(value)) return true;
    seen.add(value);
    for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
  }
  return false;
}

function parseRaw(raw: unknown): unknown {
  if (typeof raw !== 'string') {
    if (valueTooDeep(raw)) throw new Unreadable('bundleTooDeep');
    return raw;
  }
  // A UTF-16 unit is at least one byte, so this needs no encoding to refuse early.
  if (raw.length > BUNDLE_LIMITS.bytes || encoder.encode(raw).length > BUNDLE_LIMITS.bytes) throw new Unreadable('bundleTooLarge');
  if (jsonTooDeep(raw)) throw new Unreadable('bundleTooDeep');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Unreadable('bundleUnreadable');
  }
}

/** A stated line as a line this code would write, or null when it cannot be one. A detail outside the table is not shown, since it could say anything. */
function readLine(raw: unknown, ids: ReadonlyMap<string, string>): ImportLine | null {
  if (!isRecord(raw)) return null;
  const { file, line, column, endLine, excerpt, atoms, kind, disposition, detail, next, nodeKey, invisible } = raw;
  const position = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 1;
  if (typeof file !== 'string' || file.length > BUNDLE_LIMITS.file || !position(line) || !position(column) || !position(endLine)) return null;
  if (typeof kind !== 'string' || !LINE_KINDS.has(kind) || typeof disposition !== 'string' || !DISPOSITIONS.has(disposition)) return null;
  if (!Array.isArray(atoms) || atoms.length > BUNDLE_LIMITS.atoms || !atoms.every((atom) => typeof atom === 'string' && atom.length <= 32)) return null;
  if (!Array.isArray(next) || !next.every((action) => typeof action === 'string' && NEXT_ACTIONS.has(action))) return null;
  if (nodeKey !== undefined && (typeof nodeKey !== 'string' || nodeKey.length > 256)) return null;
  if (excerpt !== undefined && typeof excerpt !== 'string') return null;
  return {
    file,
    line: line as number,
    column: column as number,
    endLine: endLine as number,
    ...(typeof excerpt === 'string' ? { excerpt: excerpt.slice(0, BUNDLE_LIMITS.excerpt) } : {}),
    atoms: atoms as string[],
    kind: kind as LineKind,
    disposition: disposition as Disposition,
    detail: typeof detail === 'string' && KNOWN_DETAILS.has(detail) ? detail : DETAILS.bundleStatedDetail,
    next: next as NextAction[],
    // A line about a node names it by its new id. One that names no node in the bundle still blocks, as it says.
    ...(typeof nodeKey === 'string' ? { nodeKey: ids.get(nodeKey) ?? nodeKey } : {}),
    ...(invisible === true ? { invisible: true as const } : {}),
  };
}

interface Reader {
  found: ImportLine[];
  /** The bundle's node ids, to their new ones. */
  ids: Map<string, string>;
  taken: Set<string>;
  prefix: string;
  counter: number;
  nodes: number;
}

function finding(reader: Reader, detail: DetailKey, kind: LineKind, nodeKey: string | undefined, disposition: Disposition = 'left', next: NextAction[] = ['rewrite']): void {
  reader.found.push({ file: '', line: 1, column: 1, endLine: 1, atoms: [], kind, disposition, detail: DETAILS[detail], next, ...(nodeKey === undefined ? {} : { nodeKey }) });
}

function freshId(reader: Reader): string {
  let id: string;
  do {
    reader.counter += 1;
    id = `${reader.prefix}-${reader.counter}`;
  } while (reader.taken.has(id));
  reader.taken.add(id);
  return id;
}

/** Each string a value holds, however deep, for the secret scan. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  const stack = [value];
  while (stack.length > 0) {
    const each = stack.pop();
    if (typeof each === 'string') out.push(each);
    else if (each !== null && typeof each === 'object') {
      for (const [key, child] of Object.entries(each)) {
        out.push(key);
        stack.push(child);
      }
    }
  }
  return out;
}

const holdsSecret = (value: unknown): boolean => stringsIn(value).some((text) => findSecret(text) !== undefined);

/** A style as Normal holds it: each value checked the way a value from a class is. */
function readStyle(raw: unknown, key: string, reader: Reader): Record<string, unknown> | undefined {
  if (!isRecord(raw)) {
    finding(reader, 'refusedStyle', 'refused-attribute', key);
    return undefined;
  }
  const style: Record<string, unknown> = {};
  let external = false;
  for (const [property, value] of Object.entries(raw)) {
    const values = isStyleMap(value) ? Object.entries(value) : [['base', value] as [string, unknown]];
    const scalar = (each: unknown) => typeof each === 'string' || (typeof each === 'number' && Number.isFinite(each));
    const shapeOk = values.every(([mapKey, each]) => STYLE_MAP_KEY.test(mapKey) && scalar(each)) && (!isStyleMap(value) || Object.hasOwn(value, 'base'));
    const checks = shapeOk ? values.map(([, each]) => checkNormal(property, each)) : [];
    const ok = shapeOk && safeInlineStyle({ [property]: isStyleMap(value) ? value.base : value })[property] !== undefined && checks.every((check) => check.ok);
    if (!ok) {
      finding(reader, 'refusedStyle', 'refused-attribute', key);
      continue;
    }
    if (holdsSecret(value)) {
      finding(reader, 'secret', 'secret', key);
      continue;
    }
    external ||= checks.some((check) => check.ok && check.external);
    style[property] = value;
  }
  if (external) finding(reader, 'styleExternal', 'external-address', key, 'adapted', ['accept']);
  return Object.keys(style).length > 0 ? style : undefined;
}

function readClassName(raw: unknown, key: string, reader: Reader): string | undefined {
  if (typeof raw !== 'string') {
    finding(reader, 'bundleClass', 'refused-attribute', key);
    return undefined;
  }
  const tokens = raw.split(/\s+/).filter(Boolean);
  const kept = tokens.filter((token) => KEPT_CLASS.test(token));
  if (kept.length < tokens.length) finding(reader, 'bundleClass', 'refused-attribute', key);
  return kept.length > 0 ? kept.join(' ') : undefined;
}

function readRuleList(raw: unknown, key: string, reader: Reader): unknown[] | undefined {
  if (!Array.isArray(raw)) {
    finding(reader, 'refusedRule', 'refused-rule', key);
    return undefined;
  }
  const { refused } = readRules({ rules: raw });
  const refusedAt = new Set(refused.map((each) => each.index));
  if (refused.length > 0) finding(reader, 'refusedRule', 'refused-rule', key);
  const kept = raw.filter((rule, index) => {
    if (refusedAt.has(index)) return false;
    if (!holdsSecret(rule)) return true;
    finding(reader, 'secret', 'secret', key);
    return false;
  });
  return kept.length > 0 ? kept : undefined;
}

/** One attribute, through the checks layer 1 applies to source. Undefined when it is refused, with its line. */
function readAttribute(name: string, value: unknown, tag: string, key: string, reader: Reader): unknown {
  const lower = name.toLowerCase();
  const refuse = (detail: DetailKey) => {
    finding(reader, detail, 'refused-attribute', key);
    return undefined;
  };
  const keyed = KEYED_NAMES.get(lower);
  if (keyed !== undefined && keyed !== name) return refuse('refusedAttribute');
  if (name === 'key' || name === 'ref' || name === 'class' || /^on/i.test(name)) return refuse('refusedAttribute');
  if (isPlatformAttribute(name)) return refuse('platformAttribute');
  if (FORM_LOGIC_NAMES.has(lower) || (lower === 'action' && tag.toLowerCase() === 'form')) return refuse('form');
  if (!isRenderedAttribute(lower) || isDroppedProp(name, value)) return refuse('refusedAttribute');
  if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) return refuse('refusedAttribute');
  if (name === 'id' && isDroppedId(tag, value)) return refuse('refusedAttribute');
  if (holdsSecret(value)) {
    finding(reader, 'secret', 'secret', key);
    return undefined;
  }
  if (typeof value === 'string' && fetchesElsewhere(lower, tag.toLowerCase(), value)) finding(reader, 'attributeExternal', 'external-address', key, 'adapted', ['accept']);
  return value;
}

/** A node's props through the checks a stored node meets, or the line that says what went. */
function readProps(raw: unknown, type: string, key: string, reader: Reader): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (raw === undefined) return props;
  if (!isRecord(raw)) {
    finding(reader, 'bundleNode', 'refused-attribute', key);
    return props;
  }
  for (const [name, value] of Object.entries(raw)) {
    if (name === 'children') {
      if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) finding(reader, 'bundleNode', 'expression', key);
      else if (holdsSecret(value)) finding(reader, 'secret', 'secret', key);
      else props.children = value;
      continue;
    }
    if (type === TEXT_NODE_TYPE) {
      finding(reader, 'bundleField', 'attribute', key);
      continue;
    }
    if (name === 'style') {
      const style = readStyle(value, key, reader);
      if (style) props.style = style;
    } else if (name === 'rules') {
      const rules = readRuleList(value, key, reader);
      if (rules) props.rules = rules;
    } else if (name === 'className') {
      const className = readClassName(value, key, reader);
      if (className) props.className = className;
    } else if (name === 'bindings') {
      finding(reader, 'bundleBindings', 'attribute', key);
    } else if (name === 'behaviour') {
      finding(reader, 'bundleBehaviour', 'handler', key);
    } else {
      const kept = readAttribute(name, value, type, key, reader);
      if (kept !== undefined) props[name] = kept;
    }
  }
  return props;
}

interface Pending {
  raw: unknown;
  /** Where the read node goes. */
  into: ComponentNode[] | null;
  depth: number;
  foreign: ForeignContent;
  /** The node it goes into, which a line about a node that never arrived names. */
  parent?: string;
}

/** Every node, without recursion: a forged tree can be as deep as the depth check allows. */
function readTree(raw: unknown, reader: Reader): ComponentNode | undefined {
  const roots: ComponentNode[] = [];
  const stack: Pending[] = [{ raw, into: roots, depth: 0, foreign: false }];
  while (stack.length > 0) {
    const { raw: each, into, depth, foreign, parent } = stack.pop() as Pending;
    if (!into) continue;
    reader.nodes += 1;
    if (reader.nodes > IMPORT_LIMITS.outputNodes) throw new Unreadable('overNodes');
    if (depth >= IMPORT_LIMITS.outputDepth) throw new Unreadable('overDepth');
    if (!isRecord(each) || typeof each.type !== 'string') {
      finding(reader, 'bundleNode', 'element', parent);
      continue;
    }
    const stated = typeof each.id === 'string' ? each.id : undefined;
    const id = freshId(reader);
    if (stated !== undefined && !reader.ids.has(stated)) reader.ids.set(stated, id);
    const { type } = each;
    if (type === '#component') {
      finding(reader, 'bundleComponent', 'unknown-component', id);
      continue;
    }
    const isText = type === TEXT_NODE_TYPE;
    if (!isText && (!PLAIN_TAG.test(type) || isBlockedTag(type, foreign))) {
      finding(reader, 'refusedTag', 'refused-tag', id);
      continue;
    }
    for (const field of Object.keys(each)) {
      if (field === 'bindings') finding(reader, 'bundleBindings', 'attribute', id);
      else if (field === 'behaviour') finding(reader, 'bundleBehaviour', 'handler', id);
      else if (!NODE_FIELDS.has(field)) finding(reader, 'bundleField', 'attribute', id);
    }
    const props = readProps(each.props, type, id, reader);
    const node: ComponentNode = { id, type, ...(Object.keys(props).length > 0 ? { props: props as ComponentNode['props'] } : {}) };
    into.push(node);
    if (each.children === undefined) continue;
    if (!Array.isArray(each.children) || isText) {
      finding(reader, 'bundleNode', 'element', id);
      continue;
    }
    const children: ComponentNode[] = [];
    node.children = children;
    const inner = contentBelow(type, foreign);
    for (let i = each.children.length - 1; i >= 0; i -= 1) stack.push({ raw: each.children[i], into: children, depth: depth + 1, foreign: inner, parent: id });
  }
  const root = roots[0];
  if (root && root.children?.length === 0) delete root.children;
  return root;
}

/** Ids a reference names, inside the import. One naming anything else would point into the page, so it goes. */
function followReferences(root: ComponentNode, reader: Reader): void {
  const htmlIds = new Set<string>();
  const all: ComponentNode[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ComponentNode;
    all.push(node);
    const id = (node.props as Record<string, unknown> | undefined)?.id;
    if (typeof id === 'string') htmlIds.add(id);
    for (const child of node.children ?? []) if (typeof child === 'object' && child !== null) stack.push(child);
    if (node.children?.length === 0) delete node.children;
  }
  for (const node of all) {
    const props = node.props as Record<string, unknown> | undefined;
    if (!props) continue;
    for (const [name, value] of Object.entries(props)) {
      if (typeof value !== 'string') continue;
      const named = isIdReference(name) ? value.split(/\s+/).filter(Boolean) : /^(?:href|usemap)$/i.test(name) && value.startsWith('#') && value.length > 1 ? [value.slice(1)] : [];
      if (named.length > 0 && !named.every((each) => htmlIds.has(each))) {
        delete props[name];
        finding(reader, 'bundleReference', 'refused-attribute', node.id);
      }
    }
  }
}

const unreadable = (detail: DetailKey): ReadBundle => {
  const found: ImportLine[] = [{ file: '', line: 1, column: 1, endLine: 1, atoms: [], kind: 'cap', disposition: 'left', detail: DETAILS[detail], next: ['rewrite'] }];
  return { stated: { lines: [], counts: { converted: 0, adapted: 0, rebuilt: 0, left: 0 }, verdict: 'not-imported' }, found, verdict: 'not-imported', ids: new Map() };
};

/**
 * A bundle, from a worker or an uploaded file alike, as what may enter `project`. Pure, and
 * meant to run in the worker, so that a huge or deep file costs that thread. Never throws.
 */
export function readBundle(raw: unknown, project: ProjectContext): ReadBundle {
  try {
    const bundle = parseRaw(raw);
    if (!isRecord(bundle) || bundle.format !== BUNDLE_FORMAT || !isRecord(bundle.report)) return unreadable('bundleUnreadable');
    const hash = typeof bundle.sourceHash === 'string' && SOURCE_HASH.test(bundle.sourceHash) ? bundle.sourceHash : '';
    const reader: Reader = { found: [], ids: new Map(), taken: new Set(project.ids), prefix: `imp-${hash.slice(0, 8) || 'x'}`, counter: 0, nodes: 0 };

    const nodes = bundle.nodes === undefined ? undefined : readTree(bundle.nodes, reader);
    if (nodes) {
      followReferences(nodes, reader);
      if (holdsSecret(nodes)) {
        // Every place one can sit was checked above, so this only fires on a path a later field adds unchecked.
        return unreadable('secret');
      }
    }
    if (bundle.definitions !== undefined) finding(reader, 'bundleDefinitions', 'unknown-component', undefined);
    for (const field of Object.keys(bundle)) {
      if (!['format', 'sourceHash', 'nodes', 'definitions', 'report'].includes(field)) finding(reader, 'bundleField', 'statement', undefined);
    }

    const rawLines = Array.isArray(bundle.report.lines) ? bundle.report.lines.slice(0, IMPORT_LIMITS.reportLines) : [];
    const lines = rawLines.map((each) => readLine(each, reader.ids)).filter((line): line is ImportLine => line !== null);
    if (lines.length < (Array.isArray(bundle.report.lines) ? bundle.report.lines.length : 1)) finding(reader, 'bundleReportLine', 'statement', undefined, 'adapted', []);
    const counts: Record<Disposition, number> = { converted: 0, adapted: 0, rebuilt: 0, left: 0 };
    for (const line of lines) counts[line.disposition] += 1;
    const stated: ImportReport = { lines, counts, verdict: verdictOf(lines, nodes !== undefined) };
    return { ...(nodes ? { nodes } : {}), stated, found: reader.found, verdict: verdictOf([...lines, ...reader.found], nodes !== undefined), ids: reader.ids };
  } catch (error) {
    if (error instanceof Unreadable) return unreadable(error.detail);
    // A stack that ran out, or anything else: the file is refused, never the reader.
    return unreadable(error instanceof RangeError ? 'bundleTooDeep' : 'bundleUnreadable');
  }
}
