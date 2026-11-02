// scopeIntrospection: ancestry walk used by the editor binding picker to learn
// which scope frames are available for a given node.
//
// The binding resolver runtime (src/lib/bindings/resolver/*) builds the LIVE
// scope chain at render time. This module is its editor-time mirror: given a
// node in the MST tree, it walks the component ancestry to discover whether a
// row frame is available (the node lives inside a Collection / RecordView /
// TableView) and, when so, WHICH collection that row frame is sourced from.
//
// This is intentionally NOT React and does NOT touch the data source: it only
// reads the static binding shape off the ancestry. The picker resolves the
// actual columns LIVE via useDataSource().getCollection(collectionId) using the
// collectionId returned here. It NEVER throws; an orphan / detached node simply
// yields the page frame only.

import { getParent, getParentOfType, hasParent, hasParentOfType, isStateTreeNode } from 'mobx-state-tree';
import type { ComponentInstance } from '@/models/ComponentModel';
import { ComponentDefinitionModel, type ComponentDefinitionInstance } from '@/models/ComponentDefinitionModel';
import type { ReadBinding } from '@/lib/bindings/types';
import type { InputDefinition } from '@/lib/components/inputs';
import { isRepeatable, repeatInputId } from '@/lib/components/repeat';

/** The kind of data component an ancestor row frame is sourced from. */
export type ScopeFrameSource = 'collection' | 'record-view' | 'table-view';

/**
 * A scope frame available to a node, as seen at edit time.
 *
 * - `page`: always present. Drives `{{page.params.*}}` bindings.
 * - `row`: present when an ancestor is a Collection / RecordView / TableView.
 *   `collectionId` is the source collection id read off that ancestor's binding
 *   (null when the ancestor is not yet bound to a source). `source` records
 *   which data component supplied the frame.
 * - `product`: present when an ancestor is a Product list or Product detail,
 *   which push a product frame (`{{product.*}}`) at render time.
 * - `input`: the node is inside a reusable component's definition, which reads
 *   what each placement passes (`{{input.*}}`). It replaces the page frame there:
 *   a definition that reads the page, or a collection around one placement, works
 *   in one place and silently nowhere else. `inputs` are the definition's.
 * - `item`: the node is, or sits inside, a node of the definition repeated once
 *   per item of a `list` or `gallery` input (`props['data-repeat']`), which reads
 *   its item (`{{item.*}}`). `list` is that input.
 */
export interface ScopeFrameInfo {
  kind: 'page' | 'row' | 'product' | 'input' | 'item';
  collectionId?: string | null;
  source?: ScopeFrameSource;
  inputs?: readonly InputDefinition[];
  definitionId?: string;
  list?: InputDefinition;
}

/** The reusable component whose definition holds this node, if one does. */
export function owningDefinition(node: ComponentInstance): ComponentDefinitionInstance | undefined {
  if (!isStateTreeNode(node)) return undefined;
  try {
    return hasParentOfType(node, ComponentDefinitionModel) ? getParentOfType(node, ComponentDefinitionModel) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the source collection id off a data component's read-binding. We only
 * resolve a LITERAL collection id here (e.g. `col_events`); a `{{...}}` template
 * expression cannot be resolved without a live runtime scope, so it returns
 * null and the picker shows no row columns (never a wrong guess).
 */
function literalCollectionId(binding: ReadBinding | undefined): string | null {
  if (!binding || binding.mode !== 'read') return null;
  const raw = typeof binding.expression === 'string' ? binding.expression.trim() : '';
  if (!raw) return null;
  if (raw.startsWith('{{')) return null;
  return raw;
}

/** Marker prop the registry stamps on data components. */
function dataComponentKindOf(node: ComponentInstance): string | undefined {
  const props = node.props as Record<string, unknown> | undefined;
  const kind = props?.['data-component-kind'];
  return typeof kind === 'string' ? kind : undefined;
}

/**
 * The parent ComponentModel of a node, or undefined at the top of the tree.
 *
 * `children` is an MST array, so a child node sits TWO levels under its parent
 * model (model -> children array -> child). We guard the candidate so we never
 * mistake a non-component container (the page, the canvasNodes map) for a
 * component ancestor.
 */
function getParentComponent(node: ComponentInstance): ComponentInstance | undefined {
  if (!isStateTreeNode(node)) return undefined;
  try {
    if (!hasParent(node, 2)) return undefined;
    const candidate = getParent(node, 2) as unknown;
    if (
      candidate &&
      typeof candidate === 'object' &&
      'children' in candidate &&
      'type' in candidate
    ) {
      return candidate as ComponentInstance;
    }
  } catch {
    // getParent throws for a detached / freshly-created root node. Treat that
    // as "no parent" rather than letting the picker crash.
    return undefined;
  }
  return undefined;
}

/**
 * Map a data-component ancestor to the row frame it exposes, or null if the
 * node is not a row-producing data component.
 */
function rowFrameFor(node: ComponentInstance): ScopeFrameInfo | null {
  const kind = dataComponentKindOf(node);
  if (kind === 'collection') {
    return {
      kind: 'row',
      source: 'collection',
      collectionId: literalCollectionId(node.bindings?.collection as ReadBinding | undefined),
    };
  }
  if (kind === 'table-view') {
    return {
      kind: 'row',
      source: 'table-view',
      collectionId: literalCollectionId(node.bindings?.collection as ReadBinding | undefined),
    };
  }
  if (kind === 'record-view') {
    return {
      kind: 'row',
      source: 'record-view',
      collectionId: literalCollectionId(node.bindings?.record as ReadBinding | undefined),
    };
  }
  return null;
}

/**
 * Walk a node's ancestry and return the scope frames available to it.
 *
 * Returns a page frame, or inside a definition an input frame. When the node lives (at any depth) inside a
 * Collection / RecordView / TableView, the INNERMOST such ancestor contributes
 * a row frame carrying that ancestor's source collectionId; inside a Product
 * list or Product detail a product frame is added. A deeply-nested
 * node (Collection > Stack > Card > Text) therefore still resolves the
 * Collection ancestor's collectionId.
 */
export function getAvailableScopeFrames(node: ComponentInstance): ScopeFrameInfo[] {
  const definition = owningDefinition(node);
  const frames: ScopeFrameInfo[] = definition
    ? [{ kind: 'input', inputs: definition.inputs, definitionId: definition.id }]
    : [{ kind: 'page' }];

  // The nearest repeat, the node's own included, gives the item it reads.
  if (definition) {
    for (let at: ComponentInstance | undefined = node, depth = 0; at && depth < 1000; at = getParentComponent(at), depth++) {
      const repeatId = repeatInputId(at.props);
      if (!repeatId) continue;
      const list = definition.inputs.find((input) => input.id === repeatId && isRepeatable(input));
      if (list) frames.push({ kind: 'item', list });
      break;
    }
  }

  let current = getParentComponent(node);
  let hasRow = false;
  let hasProduct = false;
  // Guard against pathological cycles with a generous depth cap.
  let guard = 0;
  while (current && guard < 1000 && !(hasRow && hasProduct)) {
    const rowFrame = hasRow ? null : rowFrameFor(current);
    if (rowFrame) {
      frames.push(rowFrame); // innermost row-producing ancestor wins
      hasRow = true;
    }
    const kind = dataComponentKindOf(current);
    if (!hasProduct && (kind === 'product-list' || kind === 'product-detail')) {
      frames.push({ kind: 'product' });
      hasProduct = true;
    }
    current = getParentComponent(current);
    guard += 1;
  }

  return frames;
}
