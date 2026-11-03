// src/lib/siteOps/applyOps.ts
//
// Apply one batch of site operations (./types.ts) to a ProjectModel, all or
// nothing. Every operation maps onto an editor action that already exists
// (ProjectModel.createPage, updatePageSettings, updateTheme, placeComponent;
// PageModel.moveTreeComponent, deleteComponent; ComponentModel
// updateResponsiveStyle, setRuleStyle, setTextContent, setProps, addRule), so a
// batch can do nothing the editor could not, and each value passes the same rules
// the AI generator and the review pass apply:
//
//   - insertNodes: the generation format through validateGeneration
//     (src/lib/ai/pageGen/validate.ts), then toEditorSnapshot for the page's
//     breakpoint ids. The validator repairs and drops with a warning; here ANY
//     warning refuses the operation (the plan's blocked content contract: a write
//     tool rejects, it never drops silently). The one exception keeps the shape:
//     text beside children becomes a leading text node.
//   - updateStyle and setProps: the value as a one-node generation of the node's
//     own tag (inside its svg or math, where it stands), so a style value or an
//     attribute is accepted exactly when the generator would keep it.
//   - updateText and removeNode: the review pass's checks (src/lib/ai/review/ops.ts).
//   - addRule: the generator's rule checks, then the rule parser inside addRule.
//
// Then the render gate (./gate.ts) over every node the batch created or changed,
// a refused component edit (ProjectModel's size middleware takes it back) counts
// as a failure, and the result must survive a ProjectModel.create round trip.
// When anything fails, every patch the batch made is taken back, so the project
// is exactly as it was (a fresh load on the server, a live store in the editor).
//
// Pure apart from the injected photo resolver; client-safe.

import { SHOP_PART_ATTR } from '@/lib/commerce/parts';
import { getSnapshot, recordPatches } from 'mobx-state-tree';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType, InsertTarget } from '@/models/PageModel';
import ComponentModel, { type ComponentInstance, type ComponentSnapshotIn, type NewRule } from '@/models/ComponentModel';
import type { SiteTheme } from '@/lib/site/theme';
import { isPlacementType } from '@/lib/components/placement';
import { isTextNodeType, TEXT_NODE_TYPE } from '@/lib/renderer/textNode';
import { isVoidTag } from '@/lib/drag/voidTags';
import { PROJECT_BODY_MAX_BYTES } from '@/lib/api/respond';
import { BASE_KEY, isAcceptedStyleKey, styleKeyFrom, type BreakpointKey } from '@/lib/ai/pageGen/schema';
import { validateGeneration, type GeneratedNodeSnapshot, type ImageRequest } from '@/lib/ai/pageGen/validate';
import { breakpointKeyMap, toEditorSnapshot } from '@/lib/ai/pageGen/apply';
import { STOCK_CREDIT_ATTRS, isSameUnsplashPhoto } from '@/lib/ai/pageGen/stockCredit';
import { siteAddressOf, siteContextFromSettings } from '@/lib/ai/pageGen/promptSections/siteContext';
import { indexReviewTree, validateReviewOps } from '@/lib/ai/review/ops';
import type { ReviewTreeNode } from '@/lib/ai/review/protocol';
import { keyedBreakpoints, type KeyedBreakpoint } from './breakpoints';
import { foreignContentOf, renderGateProblem, type GateNode } from './gate';
import { MAX_BATCH_OPS, OperationSchema, type Operation, type RejectedOperation } from './types';

/** The prefix of a reference to something an earlier operation created. */
export const REF_PREFIX = 'ref:';

/** The validator's one repair that keeps the tree's shape (see the header). */
const SHAPE_KEEPING_WARNING = 'node had text and children, text moved into a leading text node';

/** Props setProps leaves to their own operations (or to nobody). */
const PROPS_NOT_SET_HERE: ReadonlySet<string> = new Set([
  'style', 'children', 'rules', 'behaviour', 'effects', 'query', 'bindings', 'instance', 'component',
  // A shop part's role is the platform's (src/lib/commerce/parts.ts): set by the
  // control, never added, changed or removed by hand.
  SHOP_PART_ATTR,
]);

export interface ApplyDeps {
  /**
   * Places stock photos for the `imageQuery` requests of inserted nodes (the
   * server's Unsplash search): the nodes with the photos written in, and how many
   * requests found none. Without it an imageQuery is refused.
   */
  placeImages?: (
    nodes: GeneratedNodeSnapshot[],
    requests: ImageRequest[],
  ) => Promise<{ nodes: GeneratedNodeSnapshot[]; missing: number }>;
  /** Node id factory for inserted nodes (tests). */
  newId?: () => string;
}

export type ApplyOutcome =
  | {
      ok: true;
      created: Record<string, string>;
      summary: string[];
    }
  | { ok: false; rejected: RejectedOperation[] };

class OpRefused extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Where a node lives: its page and the node itself. */
interface Located {
  page: PageModelType;
  node: ComponentInstance;
}

function pagesOf(project: ProjectModelType): PageModelType[] {
  return [
    ...(Array.from(project.pages.values()) as PageModelType[]),
    ...Array.from(project.components.values(), (definition) => definition.page as PageModelType),
  ];
}

function locate(project: ProjectModelType, nodeId: string): Located | undefined {
  for (const page of pagesOf(project)) {
    const node = page.findComponent(nodeId) as ComponentInstance | undefined;
    if (node) return { page, node };
  }
  return undefined;
}

/** The tags from the tree root down to the node's parent, outermost first. */
function ancestorTypes(page: PageModelType, node: ComponentInstance): string[] {
  const out: string[] = [];
  let parentId = node.parentId as string | undefined;
  let guard = 0;
  while (parentId && guard++ < 500) {
    const parent = page.findComponent(parentId) as ComponentInstance | undefined;
    if (!parent) break;
    out.unshift(parent.type as string);
    parentId = parent.parentId as string | undefined;
  }
  return out;
}

const asBreakpointKeys = (keyed: KeyedBreakpoint[]): BreakpointKey[] =>
  keyed.map(({ key, label, minWidth }) => ({ key, label, minWidth }));

/**
 * A breakpoint the caller named, as the id to write on: undefined for the largest
 * (desktop-first, it writes the base value) or for none. Keys and labels match
 * without case, as in the review pass.
 */
function breakpointIdFor(keyed: KeyedBreakpoint[], name: string | null | undefined): string | undefined {
  if (name === null || name === undefined || name.trim().toLowerCase() === BASE_KEY) return undefined;
  const wanted = name.trim().toLowerCase();
  const index = keyed.findIndex((b) => b.key.toLowerCase() === wanted || b.label.trim().toLowerCase() === wanted);
  if (index < 0) {
    const known = keyed.map((b) => b.key).join(', ') || 'none (this page has no breakpoint frames)';
    throw new OpRefused(`unknown breakpoint ${JSON.stringify(name)}; this page has ${known}`);
  }
  return index === 0 ? undefined : keyed[index].id;
}

/** The warnings that refuse a write (all but the shape-keeping one), as one reason. */
function refusingWarnings(warnings: readonly string[]): string | null {
  const refusing = warnings.filter((w) => !w.endsWith(SHAPE_KEEPING_WARNING));
  if (refusing.length === 0) return null;
  const shown = refusing.slice(0, 5).join('; ');
  return refusing.length > 5 ? `${shown}; and ${refusing.length - 5} more` : shown;
}

/** A failed validation as one reason: what dropped things first (the cause), then the errors. */
function refusalOf(outcome: { errors: string[]; warnings: string[] }): string {
  return [refusingWarnings(outcome.warnings), outcome.errors.slice(0, 5).join('; ')].filter(Boolean).join('; ');
}

/**
 * Run one node through the generator's rules as a one-node generation of `type`,
 * inside an svg or math wrapper when that is where the node stands. Returns the
 * cleaned node, or throws the reason when the generator would change anything.
 */
function throughGenerator(
  type: string,
  props: Record<string, unknown>,
  foreign: false | 'svg' | 'math',
  breakpoints: BreakpointKey[],
): GeneratedNodeSnapshot {
  const node = { type, props };
  const raw = foreign === 'svg' ? { type: 'svg', children: [node] } : foreign === 'math' ? { type: 'math', children: [node] } : node;
  const outcome = validateGeneration({ nodes: [raw] }, { breakpoints });
  if (!outcome.ok) throw new OpRefused(refusalOf(outcome));
  const problem = refusingWarnings(outcome.result.warnings);
  if (problem) throw new OpRefused(problem);
  if (outcome.result.imageRequests.length > 0) throw new OpRefused('imageQuery is only read by insertNodes');
  const top = outcome.result.nodes[0];
  const cleaned = foreign ? top?.children[0] : top;
  if (!cleaned) throw new OpRefused('nothing usable was left after the checks');
  return cleaned;
}

/** A node's credit attributes, which a photo it shows must keep beside it. */
function creditOf(props: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [...STOCK_CREDIT_ATTRS, 'title'] as const) {
    if (props && props[key] !== undefined) out[key] = props[key];
  }
  return out;
}

// ---------- refs ----------

interface RefSite {
  ref: string;
  /** Child indexes from the top-level node list down to the node. */
  path: number[];
}

/** Take every `ref` out of the input nodes (the validator would warn on it), remembering where it was. */
function stripRefs(nodes: unknown[]): { nodes: unknown[]; refs: RefSite[] } {
  const refs: RefSite[] = [];
  const walk = (raw: unknown, path: number[]): unknown => {
    if (!isObj(raw)) return raw;
    const { ref, ...rest } = raw;
    if (ref !== undefined) {
      if (typeof ref !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(ref)) {
        throw new OpRefused(`nodes${path.map((i) => `[${i}]`).join('.children')}: a ref is 1 to 64 letters, digits, _ or -`);
      }
      refs.push({ ref, path });
    }
    if (Array.isArray(rest.children)) rest.children = rest.children.map((c, i) => walk(c, [...path, i]));
    return rest;
  };
  return { nodes: nodes.map((n, i) => walk(n, [i])), refs };
}

/**
 * The validated node an input path became. With no refusing warning the shape is
 * the input's, apart from a leading text node where the input had text beside
 * children; that one is stepped over.
 */
function nodeAtPath(input: unknown[], output: GeneratedNodeSnapshot[], path: number[]): GeneratedNodeSnapshot | undefined {
  let inList: unknown[] = input;
  let outList: GeneratedNodeSnapshot[] = output;
  let found: GeneratedNodeSnapshot | undefined;
  for (const index of path) {
    const raw = inList[index];
    found = outList[index];
    if (!found || !isObj(raw)) return undefined;
    const rawChildren = Array.isArray(raw.children) ? raw.children : [];
    const text = isObj(raw.props) ? raw.props.children : undefined;
    const shifted = rawChildren.length > 0 && text !== undefined && found.children[0]?.type === TEXT_NODE_TYPE;
    inList = rawChildren;
    outList = shifted ? found.children.slice(1) : found.children;
  }
  return found;
}

// ---------- the gates over a whole result ----------

/** A node a write created or changed, on its page. */
export interface TouchedNode {
  page: PageModelType;
  nodeId: string;
}

/**
 * Why a written project must not be stored, or null: a touched node a renderer
 * would drop something of (checked in the namespace it stands in), a site over
 * the save size limit, or a snapshot the editor model refuses to read back.
 * Shared by a batch and by a generated page (src/lib/siteOps/generated.ts).
 */
export function projectGateProblem(project: ProjectModelType, touched: readonly TouchedNode[]): string | null {
  for (const { page, nodeId } of touched) {
    const node = page.findComponent(nodeId) as ComponentInstance | undefined;
    if (!node) continue; // removed by a later operation of the batch
    const problem = renderGateProblem(getSnapshot(node) as unknown as GateNode, foreignContentOf(ancestorTypes(page, node)));
    if (problem) return problem;
  }
  const snapshot = getSnapshot(project);
  const bytes = JSON.stringify(snapshot).length;
  if (bytes > PROJECT_BODY_MAX_BYTES) return `the site would be ${bytes} bytes, over the limit of ${PROJECT_BODY_MAX_BYTES}`;
  try {
    ProjectModel.create(snapshot);
  } catch (err) {
    return `the editor model could not read the result (${err instanceof Error ? err.message.split('\n')[0] : 'invalid snapshot'})`;
  }
  return null;
}

// ---------- the batch ----------

/**
 * Apply `rawOps` to `project`. On success the project holds the change and the
 * caller saves it; on failure nothing of it is left on the project.
 */
export async function applyOperations(
  project: ProjectModelType,
  rawOps: unknown[],
  deps: ApplyDeps = {},
): Promise<ApplyOutcome> {
  // 1. The shape of every operation, before anything is applied.
  if (rawOps.length > MAX_BATCH_OPS) {
    return { ok: false, rejected: [{ index: MAX_BATCH_OPS, op: 'batch', reason: `at most ${MAX_BATCH_OPS} operations in one batch` }] };
  }
  const ops: Operation[] = [];
  const shapeRefusals: RejectedOperation[] = [];
  rawOps.forEach((raw, index) => {
    const parsed = OperationSchema.safeParse(raw);
    if (parsed.success) ops.push(parsed.data);
    else {
      const op = isObj(raw) && typeof raw.op === 'string' ? raw.op : 'unknown';
      const reason = parsed.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join('.') || 'operation'}: ${issue.message}`)
        .join('; ');
      shapeRefusals.push({ index, op, reason });
    }
  });
  if (shapeRefusals.length > 0) return { ok: false, rejected: shapeRefusals };

  // 2. Apply in order, each against the state the earlier ones left.
  const created: Record<string, string> = {};
  const summary: string[] = [];
  const touched: TouchedNode[] = [];
  const recorder = recordPatches(project);
  const refusedEdits = () => project.refusedComponents.filter((entry) => entry.edit).length;
  const undo = (): void => {
    recorder.stop();
    recorder.undo();
  };

  // A shop part that leaves its control lands under a new id; the id it had stays good for
  // the rest of the batch, so a later operation need not know the new one.
  const renewed: Record<string, string> = {};
  const resolveId = (raw: string): string => {
    if (!raw.startsWith(REF_PREFIX)) return renewed[raw] ?? raw;
    const name = raw.slice(REF_PREFIX.length);
    const id = created[name];
    if (!id) throw new OpRefused(`${JSON.stringify(raw)} names no ref an earlier operation of this batch created`);
    return renewed[id] ?? id;
  };
  const claimRef = (ref: string | undefined, id: string): void => {
    if (ref === undefined) return;
    if (created[ref] !== undefined) throw new OpRefused(`the ref ${JSON.stringify(ref)} is used twice in this batch`);
    created[ref] = id;
  };
  const nodeFor = (rawId: string): Located => {
    const id = resolveId(rawId);
    const found = locate(project, id);
    if (!found) throw new OpRefused(`unknown node id ${JSON.stringify(rawId)}`);
    if (found.node.isViewportNode) throw new OpRefused(`${JSON.stringify(rawId)} is a breakpoint frame, not a node of the page`);
    return found;
  };
  const pageFor = (rawId: string): PageModelType => {
    const id = resolveId(rawId);
    const page = pagesOf(project).find((p) => p.id === id);
    if (!page) throw new OpRefused(`unknown page id ${JSON.stringify(rawId)}`);
    return page;
  };
  const targetFor = (page: PageModelType, to: { parentId: string; index?: number } | { siblingId: string; position: 'before' | 'after' }): InsertTarget => {
    if ('parentId' in to) {
      const parentId = resolveId(to.parentId);
      if (!page.findComponent(parentId)) throw new OpRefused(`unknown parent ${JSON.stringify(to.parentId)} on this page`);
      return { kind: 'parent', parentId, ...(to.index !== undefined ? { index: to.index } : {}) };
    }
    const siblingId = resolveId(to.siblingId);
    if (!page.findComponent(siblingId)) throw new OpRefused(`unknown sibling ${JSON.stringify(to.siblingId)} on this page`);
    return { kind: 'sibling', siblingId, position: to.position };
  };

  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    const before = refusedEdits();
    try {
      summary.push(await applyOne(op));
      if (refusedEdits() > before) {
        const last = project.refusedComponents[project.refusedComponents.length - 1];
        throw new OpRefused(last?.reason ?? 'the editor took this edit back');
      }
    } catch (err) {
      undo();
      if (err instanceof OpRefused) {
        const skipped = ops.length - index - 1;
        const rejected: RejectedOperation[] = [{ index, op: op.op, reason: err.message }];
        if (skipped > 0) rejected.push({ index: index + 1, op: 'batch', reason: `${skipped} later operation(s) not applied: the batch stopped at operation ${index}` });
        return { ok: false, rejected };
      }
      throw err;
    }
  }

  // 3. The gates over the whole result.
  const problem = projectGateProblem(project, touched);
  recorder.stop();
  if (problem) {
    recorder.undo();
    return { ok: false, rejected: [{ index: -1, op: 'batch', reason: problem }] };
  }
  return { ok: true, created, summary };

  // ---------- one operation ----------

  async function applyOne(op: Operation): Promise<string> {
    switch (op.op) {
      case 'createPage': {
        const page = project.createPage(op.title);
        if (op.slug !== undefined || op.description !== undefined) {
          const result = project.updatePageSettings(page.id, {
            title: op.title,
            slug: op.slug ?? page.slug,
            description: op.description ?? '',
          });
          if (!result.ok) throw new OpRefused(Object.values(result.errors).filter(Boolean).join(' '));
        }
        claimRef(op.ref, page.id);
        return `created page "${page.metadata.title}" at /${page.slug} (${page.id})`;
      }

      case 'updatePageSettings': {
        const page = project.pages.get(resolveId(op.pageId)) as PageModelType | undefined;
        if (!page) throw new OpRefused(`unknown page id ${JSON.stringify(op.pageId)}`);
        const result = project.updatePageSettings(page.id, {
          title: op.title ?? page.metadata.title,
          slug: op.slug ?? page.slug,
          description: op.description ?? page.metadata.description,
          ...(op.ogImage !== undefined ? { ogImage: op.ogImage } : {}),
          ...(op.noIndex !== undefined ? { noIndex: op.noIndex } : {}),
          ...(op.notFoundPage !== undefined ? { notFoundPage: op.notFoundPage } : {}),
        });
        if (!result.ok) throw new OpRefused(Object.values(result.errors).filter(Boolean).join(' '));
        return `updated the settings of page "${page.metadata.title}" (/${page.slug})`;
      }

      case 'insertNodes': {
        const page = pageFor(op.pageId);
        const parent = (op.parentId
          ? page.findComponent(resolveId(op.parentId))
          : page.appComponentTree) as ComponentInstance | undefined;
        if (!parent) throw new OpRefused(`unknown parent ${JSON.stringify(op.parentId)} on this page`);
        if (parent.isViewportNode) throw new OpRefused('a breakpoint frame holds the page, not nodes; insert into the page root');
        if (isVoidTag(parent.type) || isTextNodeType(parent.type) || isPlacementType(parent.type) || parent.props?.['data-component-kind']) {
          throw new OpRefused(`<${parent.type}> cannot contain other nodes`);
        }
        if (typeof parent.props?.children === 'string') {
          throw new OpRefused('the parent holds text; insert into a container, or replace its text with nodes');
        }

        const keyed = keyedBreakpoints(page);
        const { nodes: input, refs } = stripRefs(op.nodes);
        const site = siteContextFromSettings(project.site, project.metadata.title);
        const address = siteAddressOf(site);
        const outcome = validateGeneration(
          { nodes: input },
          {
            breakpoints: asBreakpointKeys(keyed),
            ...(deps.newId ? { newId: deps.newId } : {}),
            mapAddress: address || null,
          },
        );
        if (!outcome.ok) throw new OpRefused(refusalOf(outcome));
        const problem = refusingWarnings(outcome.result.warnings);
        if (problem) throw new OpRefused(problem);

        let nodes = outcome.result.nodes;
        if (outcome.result.imageRequests.length > 0) {
          if (!deps.placeImages) throw new OpRefused('imageQuery cannot be resolved here; use findImages and set src with its credit');
          const placed = await deps.placeImages(nodes, outcome.result.imageRequests);
          if (placed.missing > 0) {
            throw new OpRefused(`${placed.missing} imageQuery photo(s) could not be found; use findImages and set src with its credit`);
          }
          nodes = placed.nodes;
        }

        for (const site of refs) {
          const node = nodeAtPath(input, nodes, site.path);
          if (!node) throw new OpRefused(`the ref ${JSON.stringify(site.ref)} could not be matched to an inserted node`);
          claimRef(site.ref, node.id);
        }

        const keyMap = breakpointKeyMap(keyed.map(({ id, label, minWidth }) => ({ id, label, minWidth })));
        const snapshots: ComponentSnapshotIn[] = nodes.map((n) => toEditorSnapshot(n, keyMap));
        snapshots.forEach((snapshot, i) => {
          const child = ComponentModel.create({ ...snapshot, parentId: parent.id }) as ComponentInstance;
          parent.addChild(child, op.index === undefined ? undefined : op.index + i);
          if (!parent.children.some((c: ComponentInstance) => c.id === child.id)) {
            throw new OpRefused(`<${parent.type}> refused node ${i} (${child.type})`);
          }
          touched.push({ page, nodeId: child.id });
        });
        return `inserted ${outcome.result.stats.nodeCount} node(s) into ${parent.id} on page "${page.metadata.title}"`;
      }

      case 'updateStyle': {
        const { page, node } = nodeFor(op.nodeId);
        if (isTextNodeType(node.type)) throw new OpRefused('a text node has no element to style; style its parent');
        if (isPlacementType(node.type)) throw new OpRefused('a component is styled in its definition, not on a placement');
        const property = styleKeyFrom(op.property.trim());
        if (!isAcceptedStyleKey(property)) throw new OpRefused(`style key ${JSON.stringify(op.property)} is not supported by the editor`);
        const keyed = keyedBreakpoints(page);
        const breakpointId = breakpointIdFor(keyed, op.breakpoint);
        let value: string | number | undefined;
        if (op.value === null || (typeof op.value === 'string' && op.value.trim() === '')) value = undefined;
        else {
          const cleaned = throughGenerator(
            node.type,
            { ...creditOf(node.props), style: { [property]: op.value } },
            foreignContentOf(ancestorTypes(page, node)),
            asBreakpointKeys(keyed),
          );
          const kept = (cleaned.props.style as Record<string, unknown> | undefined)?.[property];
          if (kept === undefined || isObj(kept)) throw new OpRefused(`the value of ${property} was not kept by the style rules`);
          value = kept as string | number;
        }
        if (op.state) {
          const result = node.setRuleStyle(op.state, property, value, breakpointId);
          if (!result.ok) throw new OpRefused(result.reason);
        } else {
          node.updateResponsiveStyle(property, value, breakpointId);
        }
        touched.push({ page, nodeId: node.id });
        const where = [op.breakpoint ? `on ${op.breakpoint}` : '', op.state ? `while ${op.state}` : ''].filter(Boolean).join(' ');
        return `${value === undefined ? 'removed' : 'set'} ${property} of ${node.id}${where ? ` ${where}` : ''}`;
      }

      case 'updateText': {
        const { page, node } = nodeFor(op.nodeId);
        const verdict = validateReviewOps([{ op: 'update_text', nodeId: node.id, text: op.text }], {
          breakpointKeys: keyedBreakpoints(page).map((b) => b.key),
          nodes: indexReviewTree(getSnapshot(node) as unknown as ReviewTreeNode),
        });
        const accepted = verdict.ops[0];
        if (!accepted || accepted.op !== 'update_text') throw new OpRefused(verdict.rejected[0]?.reason ?? 'the text was refused');
        node.setTextContent(accepted.text);
        touched.push({ page, nodeId: node.id });
        return `set the text of ${node.id}`;
      }

      case 'setProps': {
        const { page, node } = nodeFor(op.nodeId);
        if (isTextNodeType(node.type)) throw new OpRefused('a text node holds only its text');
        if (isPlacementType(node.type)) throw new OpRefused('a placement passes its values through the component definition');
        const setting: Record<string, unknown> = {};
        const removing: string[] = [];
        for (const [key, value] of Object.entries(op.props)) {
          if (PROPS_NOT_SET_HERE.has(key)) throw new OpRefused(`${key} is not set through setProps`);
          if (value === null) removing.push(key);
          else setting[key] = value;
        }
        const patch: Record<string, unknown> = {};
        if (Object.keys(setting).length > 0) {
          // The photo's credit stays beside a photo source it does not replace.
          const keepsPhoto = setting.src === undefined || isSameUnsplashPhoto(setting.src, node.props?.src);
          const context = keepsPhoto ? creditOf(node.props) : {};
          const cleaned = throughGenerator(
            node.type,
            { ...context, ...setting },
            foreignContentOf(ancestorTypes(page, node)),
            asBreakpointKeys(keyedBreakpoints(page)),
          );
          for (const key of Object.keys(setting)) {
            if (cleaned.props[key] === undefined) throw new OpRefused(`the prop ${JSON.stringify(key)} was not kept by the attribute rules`);
            patch[key] = cleaned.props[key];
          }
          if (!keepsPhoto) {
            for (const key of [...STOCK_CREDIT_ATTRS, 'title'] as const) {
              if (setting[key] === undefined && node.props?.[key] !== undefined) patch[key] = undefined;
            }
          }
        }
        for (const key of removing) patch[key] = undefined;
        node.setProps(patch);
        touched.push({ page, nodeId: node.id });
        return `set ${Object.keys(setting).length} and removed ${removing.length} prop(s) of ${node.id}`;
      }

      case 'moveNode': {
        const { page, node } = nodeFor(op.nodeId);
        const target = targetFor(page, op.to);
        const refusal = page.dropRefusal(node.id, target);
        if (refusal) throw new OpRefused(refusal);
        const moved = page.moveTreeComponent(node.id, target);
        if (!moved) throw new OpRefused('the node cannot move there (the page root, a frame, or into itself)');
        // A shop part leaving its control lands renewed, under a new id: the old id (and every id that led to it) now names the new node.
        if (moved.id !== node.id) {
          for (const [from, to] of Object.entries(renewed)) if (to === node.id) renewed[from] = moved.id;
          renewed[node.id] = moved.id;
        }
        touched.push({ page, nodeId: moved.id });
        return moved.id === node.id ? `moved ${node.id}` : `moved ${node.id}, now a plain node ${moved.id} outside its shop control`;
      }

      case 'removeNode': {
        const { page, node } = nodeFor(op.nodeId);
        if (node.id === (page.appComponentTree as ComponentInstance).id) throw new OpRefused('the page root cannot be removed');
        if (!page.deleteComponent(node.id)) throw new OpRefused('the node could not be removed');
        return `removed ${node.id}`;
      }

      case 'addRule': {
        const { page, node } = nodeFor(op.nodeId);
        if (isTextNodeType(node.type) || isPlacementType(node.type)) throw new OpRefused('this node holds no rules');
        const keyed = keyedBreakpoints(page);
        const known = new Set([BASE_KEY, ...keyed.map((b) => b.key.toLowerCase())]);
        for (const [property, value] of Object.entries(op.rule.style)) {
          if (!isObj(value)) continue;
          const unknown = Object.keys(value).find((k) => !known.has(k.toLowerCase()));
          if (unknown) throw new OpRefused(`${property}: unknown breakpoint ${JSON.stringify(unknown)}`);
        }
        // The validator needs an id to keep a rule; addRule mints the stored one.
        const draft = { id: 'draft', ...op.rule };
        const cleaned = throughGenerator(
          node.type,
          { ...creditOf(node.props), rules: [draft] },
          foreignContentOf(ancestorTypes(page, node)),
          asBreakpointKeys(keyed),
        );
        const keyMap = breakpointKeyMap(keyed.map(({ id, label, minWidth }) => ({ id, label, minWidth })));
        const rules = toEditorSnapshot(cleaned, keyMap).props?.rules;
        if (!Array.isArray(rules) || rules.length === 0) throw new OpRefused('the rule was not kept by the rule checks');
        for (const rule of rules as NewRule[]) {
          // The draft's id goes: addRule mints the stored one.
          const result = node.addRule({ ...rule, id: undefined } as NewRule);
          if (!result.ok) throw new OpRefused(result.reason);
        }
        touched.push({ page, nodeId: node.id });
        return `added the rule ${op.rule.selector} to ${node.id}`;
      }

      case 'setTheme': {
        const result = project.updateTheme(op.theme as unknown as SiteTheme);
        if (!result.ok) throw new OpRefused(result.errors.slice(0, 5).join('; '));
        return `replaced the theme (${op.theme.tokens.length} token(s))`;
      }

      case 'placeComponent': {
        const page = pageFor(op.pageId);
        const target: InsertTarget = op.to ? targetFor(page, op.to) : { kind: 'appTree' };
        const result = project.placeComponent(page.id, resolveId(op.definitionId), target);
        if (!result.ok) throw new OpRefused(result.message);
        claimRef(op.ref, result.placement.id);
        touched.push({ page, nodeId: result.placement.id });
        return `placed component ${op.definitionId} on page "${page.metadata.title}" (${result.placement.id})`;
      }
    }
  }
}
