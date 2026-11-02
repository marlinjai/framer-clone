// applyBehaviour: turns each node's stored `props.behaviour` into what the published
// page renders, and returns the program the runtime will run. See
// docs/plans/2026-11-02-behaviour-model.md, "From stored data to a page".
//
// Runs on the HYDRATED tree, after hoistStickyCta and before applyEffects, so cloned
// rows and hoisted nodes are in their final place and the rules it adds reach
// applyResponsiveStyles. `readBehaviourTree` is the trust boundary: nothing here reads
// a stored behaviour except through it, and `behaviour` never leaves this step, which
// also keeps it out of what crosses to a client island.
//
// Per node:
//   - State goes on its scope as `data-fcs-<id>`, for CSS. `text` is never written.
//   - Bindings are evaluated at the first value, so the first HTML is true, and a text
//     binding marks its element for React, whose hydration keeps the text.
//   - `showWhen`, `noScript` and every `when` become rules on the node, parsed here
//     against the state on the node's path, in `compiledRules`. `applyResponsiveStyles`
//     takes that list instead of `props.rules`. It cannot be stored: the snapshot adapter
//     maps five fields, and this is not one of them.
//   - On a page with a trigger, `data-fc-*` marks what the runtime has to find.
//
// The program is what leaves for the browser, so `compileEntry` reduces each entry to what
// the runtime reads. It travels in the props of BehaviourIsland, in the payload Next escapes.
//
// One key can cover nodes whose behaviour differs: a placement with its own trigger, or
// a row whose bound `type` changes what parses. So the program holds a list per key, and
// `data-fc-v` says which entry an element runs. References stay on the key.
//
// A page with no behaviour gets the same tree back, but for an id repeated in a Collection
// that something in the row points at (src/lib/renderer/idRefs.ts). A page with state and no trigger can never change, so it
// gets no gate, no marks and no program: its rules read what the server wrote.
//
// A stored `data-fc-n` or `data-fcs-*` would forge a target or a state, past every
// refusal of the parser. Expansion strips those, and they are dropped here again, so
// that guarantee does not rest on what called this step.
//
// PURE: no React, no MST, no server-only.

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import {
  behaviourNodeKey,
  nodeFacts,
  readBehaviourTree,
  type Action,
  type Binding,
  type Expression,
  type StateValue,
  type StoredBehaviour,
} from '@/lib/behaviour/format';
import {
  NODE_ATTR,
  ROW_ATTR,
  SCOPE_ATTR,
  SHOW_ATTR,
  VARIANT_ATTR,
  bindingDom,
  conditionExpression,
  conditionSelector,
  isConstant,
  isIssuedAttribute,
  readsRow,
  stateAttributes,
} from '@/lib/behaviour/behaviourDom';
import { compileEntry, compileProgram, type BehaviourProgram, type ProgramEntry } from '@/lib/behaviour/program';
import { isIdReference, suffixCloneIds } from '@/lib/renderer/idRefs';
import { TEXT_NODE_TYPE, isTextNodeType } from '@/lib/renderer/textNode';
import { isRuleList, readRules, type ParsedRule, type ParsedSelectorRule, type ReadRules } from '@/lib/rules/rules';
import { formKindOf } from '@/lib/forms/definition';

/** An entry left out, with why. A refused entry never blocks a page. */
export interface BehaviourProblem {
  node: string;
  rule?: string;
  reason: string;
}

export interface BehaviourResult {
  /** The rewritten tree, or the same tree when there was nothing to do. */
  root: ComponentNode;
  /** Null when nothing on the page can change. */
  program: BehaviourProgram | null;
  /** The page has a trigger: it needs the gate, and `when` rules stand behind it. */
  hasGate: boolean;
}

const HIDE = { display: 'none !important' };

/** What a person presses. A trigger on anything else watches what the element does natively. */
const PRESS_EVENTS: ReadonlySet<string> = new Set(['click', 'dblclick', 'keydown', 'keyup', 'pointerdown', 'pointerup', 'mousedown', 'mouseup']);
/** On a button, these give it a job with no script at all. */
const NATIVE_COMMANDS: ReadonlySet<string> = new Set(['popovertarget', 'commandfor', 'formaction', 'form']);
/** What may sit in a button that is otherwise only its label. */
const ICON_TAGS: ReadonlySet<string> = new Set(['svg', 'img', 'i']);

function holdsBehaviour(node: ComponentNode): boolean {
  return (node.props as Record<string, unknown> | undefined)?.behaviour !== undefined || (node.children ?? []).some(holdsBehaviour);
}

/** True for a button with nothing inside it but its label, and nothing to do without a script. */
function isScriptOnlyButton(node: ComponentNode, tag: string | null, insideForm: boolean): boolean {
  const props = (node.props ?? {}) as Record<string, unknown>;
  const typed = typeof props.type === 'string' ? props.type.toLowerCase() : undefined;
  const role = typeof props.role === 'string' ? props.role.toLowerCase() : undefined;
  // A `button` in a form with no type of its own is that form's submit.
  const inert = tag === 'button' ? typed === 'button' || (typed === undefined && !insideForm) : role === 'button' && tag !== 'a';
  if (!inert || Object.keys(props).some((name) => NATIVE_COMMANDS.has(name.toLowerCase()))) return false;
  return (node.children ?? []).every((child) => isTextNodeType(child.type) || ICON_TAGS.has(child.type.toLowerCase()));
}

/**
 * `noScript`, or its default. Only a button that needs the script is hidden, which would
 * otherwise do nothing and lie through a stale `aria-*`. Anything else may hold content,
 * and content stays reachable without a script.
 */
function noScriptOf(behaviour: StoredBehaviour, node: ComponentNode, insideForm: boolean): 'show' | 'hide' | undefined {
  if (behaviour.noScript) return behaviour.noScript;
  const facts = nodeFacts(node);
  const presses = (behaviour.on ?? []).some((trigger) => PRESS_EVENTS.has(trigger.on));
  const claims = (behaviour.bind ?? []).some((binding) => 'attr' in binding && binding.attr.startsWith('aria-'));
  return presses && claims && !facts.island && isScriptOnlyButton(node, facts.tag, insideForm) ? 'hide' : undefined;
}

/** Adds every node key an expression names. */
function keysOfExpression(expression: Expression, out: Set<string>): void {
  if (typeof expression !== 'object') return;
  if ('pointer' in expression) out.add(expression.of);
  else if ('active' in expression) out.add(expression.active);
  else if ('map' in expression) {
    Object.values(expression.cases).forEach((entry) => keysOfExpression(entry, out));
    if (expression.default !== undefined) keysOfExpression(expression.default, out);
  } else {
    for (const value of Object.values(expression)) {
      if (Array.isArray(value)) (value as Expression[]).forEach((entry) => keysOfExpression(entry, out));
      else if (typeof value === 'object') keysOfExpression(value as Expression, out);
    }
  }
}

/** Adds every node key an action names, what it nests included. */
function keysOfAction(action: Action, out: Set<string>): void {
  if ('delay' in action) {
    action.do.forEach((entry) => keysOfAction(entry, out));
    return;
  }
  for (const verb of ['focus', 'rove', 'dialog', 'popover', 'details', 'media', 'fullscreen', 'pictureInPicture', 'scroll', 'form', 'setProp', 'filter', 'effect'] as const) {
    const key = (action as Record<string, unknown>)[verb];
    if (typeof key === 'string') out.add(key);
  }
  for (const value of [(action as { value?: Expression }).value, (action as { text?: Expression }).text]) {
    if (value !== undefined) keysOfExpression(value, out);
  }
}

/** Every key something on the page resolves at run time. */
function referencedKeys(behaviours: Iterable<StoredBehaviour>): Set<string> {
  const out = new Set<string>();
  for (const behaviour of behaviours) {
    for (const trigger of behaviour.on ?? []) {
      trigger.do.forEach((action) => keysOfAction(action, out));
      if (trigger.if !== undefined && !(typeof trigger.if === 'object' && ('state' in trigger.if || 'all' in trigger.if || 'any' in trigger.if))) {
        keysOfExpression(trigger.if as Expression, out);
      }
    }
    for (const binding of behaviour.bind ?? []) keysOfExpression('text' in binding ? binding.text : binding.from, out);
    if (behaviour.group?.virtual) out.add(behaviour.group.virtual.owner);
  }
  return out;
}

/** Props without `behaviour` and what only this step may write. */
function ownProps(node: ComponentNode): Record<string, unknown> | undefined {
  if (!node.props) return undefined;
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(node.props as Record<string, unknown>)) {
    if (name !== 'behaviour' && !isIssuedAttribute(name)) props[name] = value;
  }
  return props;
}

/** True when a stored rule list needs the state on the node's path to be read at all. */
const holdsCondition = (rules: unknown[]): boolean =>
  rules.some((rule) => !!rule && typeof rule === 'object' && ('when' in rule || 'gate' in rule));

const selectorRule = (id: string, parts: string[], extra: Pick<ParsedSelectorRule, 'when' | 'gate'>): ParsedSelectorRule =>
  ({ kind: 'selector', id, parts, at: [], style: HIDE, ...extra });

/** The node with one text child reading `text`. A parsed text binding has exactly one. */
function withText(next: ComponentNode, props: Record<string, unknown>, text: string): void {
  if (typeof props.children === 'string' || typeof props.children === 'number') {
    props.children = text;
    return;
  }
  const [child] = next.children ?? [];
  if (child?.type === TEXT_NODE_TYPE) {
    next.children = [{ ...child, props: { ...(child.props as object), children: text } as ComponentNode['props'] }];
  }
}

/** Where a walk stands. */
interface Reach {
  states: ReadonlyMap<string, StateValue>;
  /** The nearest clone's index. */
  row?: number;
  /** A form sits above this node, so a button with no type submits it. */
  insideForm?: boolean;
}

/** One line per page on the published path. The editor surfaces pass their own sink, since they rebuild on every edit. */
const warnOnce = (problems: readonly BehaviourProblem[]): void => {
  console.warn(`applyBehaviour: left out ${problems.length} stored behaviour entr${problems.length === 1 ? 'y' : 'ies'}`, problems.slice(0, 10));
};

export function applyBehaviour(root: ComponentNode, report: (problems: readonly BehaviourProblem[]) => void = warnOnce): BehaviourResult {
  if (!holdsBehaviour(root)) return { root: suffixCloneIds(root), program: null, hasGate: false };

  const tree = readBehaviourTree(root);
  const problems: BehaviourProblem[] = tree.refused.map(({ nodeId, reason }) => ({ node: nodeId ?? 'unnamed', reason }));
  const behaviours = [...tree.behaviours.values()];
  const hasGate = behaviours.some((behaviour) => (behaviour.on?.length ?? 0) > 0);
  const targets = referencedKeys(behaviours);
  const entries = new Map<string, { signature: string; entry: ProgramEntry }[]>();
  const readLists = new Map<string, ReadRules>();
  let marks = 0;

  /** Rows repeat one list against the same state, so a page reads each pairing once. */
  const readConditional = (list: unknown[], states: ReadonlyMap<string, StateValue>, nodeId: string, pageRoot: boolean): ReadRules => {
    const signature = `${pageRoot}\u0000${JSON.stringify([...states.values()])}\u0000${JSON.stringify(list)}`;
    const known = readLists.get(signature);
    if (known) return known;
    const read = readRules({ rules: list }, { states, pageRoot });
    readLists.set(signature, read);
    for (const { index, reason, rule } of read.refused) {
      const id = (rule as { id?: unknown } | null)?.id;
      problems.push({ node: nodeId, rule: typeof id === 'string' ? id : `#${index}`, reason });
    }
    return read;
  };

  /** The list of rules a node's list and behaviour come to, or null when its list stays as stored. */
  const compileRules = (node: ComponentNode, props: Record<string, unknown>, behaviour: StoredBehaviour | undefined, bindings: Binding[], reach: Reach): ParsedRule[] | null => {
    if (isTextNodeType(node.type)) return null;
    const nodeId = node.id ?? 'unnamed';
    const rules: ParsedRule[] = [];
    const list = isRuleList(props.rules) ? props.rules : [];
    const noScript = behaviour ? noScriptOf(behaviour, node, reach.insideForm === true) : undefined;
    if (!holdsCondition(list) && !behaviour?.showWhen && noScript !== 'hide') return null;

    if (list.length > 0) {
      const read = readConditional(list, reach.states, nodeId, node === root && !node.placementRoot);
      rules.push(...read.rules.filter((rule) => hasGate || rule.kind !== 'selector' || rule.gate !== 'off'));
      delete props.rules;
    }
    if (noScript === 'hide' && hasGate) rules.push(selectorRule('no-script', ['&'], { gate: 'off' }));
    const condition = behaviour?.showWhen;
    if (condition && !readsRow(condition)) {
      rules.push(selectorRule('show-when', ['&'], { when: conditionSelector({ not: condition }) }));
    } else if (condition && reach.row === undefined) {
      problems.push({ node: nodeId, reason: 'showWhen compares with the row, and this node is in no clone, so it stays visible' });
    } else if (condition && bindings.some((binding) => 'attr' in binding && binding.attr === SHOW_ATTR)) {
      problems.push({ node: nodeId, reason: `showWhen compares with the row through ${SHOW_ATTR}, which another binding writes, so it stays visible` });
    } else if (condition) {
      bindings.push({ attr: SHOW_ATTR, from: conditionExpression(condition) });
      rules.push(selectorRule('show-when', [`&:not([${SHOW_ATTR}="true"])`], { gate: 'on' }));
    }
    return rules;
  };

  /** The bindings that stand here. A clone's ids change per row, and one program cannot write a bound id for each. */
  const standingBindings = (node: ComponentNode, behaviour: StoredBehaviour | undefined, reach: Reach): Binding[] =>
    (behaviour?.bind ?? []).filter((binding) => {
      const follows = 'attr' in binding && isIdReference(binding.attr) && !isConstant(binding.from);
      if (!follows || reach.row === undefined) return true;
      problems.push({ node: node.id ?? 'unnamed', reason: `${binding.attr} is bound in a clone, whose ids differ per row, so it cannot follow state` });
      return false;
    });

  /** What the runtime has to do on this node, as one program entry. */
  const entryOf = (behaviour: StoredBehaviour | undefined, bindings: Binding[]): ProgramEntry =>
    compileEntry(behaviour, bindings.filter((binding) => !isConstant('text' in binding ? binding.text : binding.from)));

  /** Files the entry under the key, and says which of the key's entries it is. */
  const fileEntry = (key: string, entry: ProgramEntry): number => {
    const signature = JSON.stringify(entry);
    const list = entries.get(key) ?? [];
    const known = list.findIndex((item) => item.signature === signature);
    if (known !== -1) return known;
    entries.set(key, [...list, { signature, entry }]);
    return list.length;
  };

  const visit = (node: ComponentNode, outer: Reach): ComponentNode => {
    const behaviour = tree.behaviours.get(node);
    const isClone = typeof node.cloneIndex === 'number';
    const isForm = typeof node.type === 'string' && (node.type.toLowerCase() === 'form' || formKindOf((node.props ?? {}) as Record<string, unknown>) === 'form');
    const reach: Reach = { states: outer.states, row: isClone ? node.cloneIndex : outer.row, insideForm: outer.insideForm || isForm };
    if (behaviour?.state) reach.states = new Map([...outer.states, ...behaviour.state.map((state): [string, StateValue] => [state.id, state])]);

    const next: ComponentNode = { ...node };
    const props = ownProps(node);
    const before = marks;
    if (node.children) next.children = node.children.map((child) => visit(child, reach));
    if (!props) return next;

    const bindings = standingBindings(node, behaviour, reach);
    const compiled = compileRules(node, props, behaviour, bindings, reach);
    if (compiled) next.compiledRules = compiled;

    if (behaviour?.state) Object.assign(props, stateAttributes(behaviour.state));
    const facts = nodeFacts(node);
    const dom = bindingDom(bindings, (id) => reach.states.get(id)?.initial, reach.row, facts.tag);
    Object.assign(props, dom.attributes);
    if ('defaultValue' in dom.attributes) delete props.value;
    if (Object.keys(dom.style).length > 0) props.style = { ...(props.style as object | undefined), ...dom.style };
    if (bindings.some((binding) => 'text' in binding)) {
      props.suppressHydrationWarning = true;
      if (dom.text !== undefined) withText(next, props, dom.text);
    }

    if (hasGate) {
      const key = behaviourNodeKey(node);
      const entry = entryOf(behaviour, bindings);
      if (key !== null && (Object.keys(entry).length > 0 || targets.has(key))) {
        const variant = fileEntry(key, entry);
        props[NODE_ATTR] = key;
        if (variant > 0) props[VARIANT_ATTR] = String(variant);
        marks += 1;
      }
      const needed = marks > before;
      if (behaviour?.state || ((isClone || node.placementRoot) && needed)) props[SCOPE_ATTR] = '';
      if (isClone && needed) props[ROW_ATTR] = String(node.cloneIndex);
    }
    next.props = props as ComponentNode['props'];
    return next;
  };

  const rewritten = visit(root, { states: new Map() });
  // A refused entry shows in the panel and never blocks a page.
  if (problems.length > 0) report(problems);

  const nodes = Object.fromEntries(
    [...entries].filter(([, list]) => list.some(({ entry }) => Object.keys(entry).length > 0)).map(([key, list]) => [key, list.map(({ entry }) => entry)]),
  );
  return { root: suffixCloneIds(rewritten), program: hasGate ? compileProgram(nodes) : null, hasGate };
}
