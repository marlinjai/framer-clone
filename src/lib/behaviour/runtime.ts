// src/lib/behaviour/runtime.ts
//
// The client runtime of stored behaviour, shared by every surface that runs a page.
// See docs/plans/2026-11-02-behaviour-model.md, "The runtime". Vanilla DOM, a separate
// chunk reached by a dynamic import, so a page with no trigger never fetches it.
//
// It runs a parsed program, and nothing here is code. It reads no stored string as
// anything but a value, and writes attributes, custom properties and text only:
//
//   - One capture listener per event name, on `container`. An event walks up from
//     its target through the nodes holding a trigger for it, as far as it bubbles.
//   - State lives in cells per scope. Values are kept by the scope's path too, so a
//     scope an island remounts gets its values back.
//   - A write goes to `data-fcs-<id>` at once, for CSS, and bindings follow together at
//     the end of the task, so a burst of writes costs one pass over the page.
//   - What the parser cannot see is checked here: a number is a number, a choice stays
//     one of its options, a typed value stays out of what it may not reach, and a key
//     typed into a field fires nothing, wherever the trigger sits.
//   - A budget stops a program that loops through real events, which the parser's caps
//     cannot see. A no-op costs nothing, so an Escape reaching 500 closed rows is no loop.
//
// It never throws at a page. An unresolved target or a verb it does not know warns once
// and the sequence goes on. An error it did not expect stops the runtime and lowers the
// gate, so nothing stays hidden behind a dead runtime.
//
// What touches the page beyond state is in a chunk that loads beside this one, only when
// the program needs it: `verbs.ts`, which also holds the key rules. A verb with no chunk
// here warns, as for any verb it does not know, and with no rules no key fires.
//
// PURE and client-safe: no React, no MST. It imports leaves only (names.ts, dom.ts),
// because the parser would not fit the size limit test beside it.

import type { Action, Expression } from './format';
import { attrOf, childrenOf, closestTo, every, hasAttr, holds, isConnected, isElement, isMatch, one, parentOf, setAttr, toggleAttr, upFrom } from './dom';
import { GATE_GLOBAL, NODE_ATTR, ROW_ATTR, SCOPE_ATTR, VARIANT_ATTR, isBooleanAttribute, stateAttribute } from './names';
import type { BehaviourProgram, CreateVerbs, Kit, KeyRules, ProgramBinding, ProgramEntry, ProgramState, ProgramTrigger, Run } from './program';

export interface StartBehaviourOptions {
  /** What the page is in: the document, or a preview or canvas frame. */
  container: ParentNode & Node;
  program: BehaviourProgram;
  /** The attribute holding a node's key. The canvas has its own. */
  nodeAttr?: string;
  surface: 'published' | 'preview' | 'canvas';
  /** `createVerbs` of verbs.ts, when the program has a native or value action. */
  verbs?: CreateVerbs;
  /** The key rules of keys.ts, in the same chunk, when the program has a key trigger. Without them no key fires. */
  keys?: KeyRules;
}

/** What the boot script leaves on a published page (src/lib/behaviour/gate.ts). */
interface Gate {
  queue: Event[];
  ready(): boolean;
  fail(): void;
}

interface Cell {
  state: ProgramState;
  value: unknown;
}

interface Usage {
  start: number;
  count: number;
  off: boolean;
  /** Firings on what the page caused itself, since a person last did anything. */
  unprompted: number;
  /** Which `prompts` that count belongs to. */
  prompt: number;
}

export const MAX_ACTIONS_PER_TASK = 256;
export const MAX_ACTIONS_PER_SECOND = 2000;
/** All the page's work in a second: an action costs 1, and a full scan its items. */
export const MAX_PAGE_COST_PER_SECOND = 100_000;
/** Firings of one trigger on what the page caused, between two things a person did. */
export const MAX_UNPROMPTED_FIRINGS = 256;
const MAX_EMIT_DEPTH = 4;
/** The parser's limit on text state. */
const MAX_TEXT = 4096;
/** Decimal noise from a `step` would miss a condition and show in `aria-valuenow`. */
const NUMBER_PRECISION = 1e10;

/** Fire too often to run per event: they run once per frame, with the last event. */
const HIGH_FREQUENCY: ReadonlySet<string> = new Set(['pointermove', 'mousemove', 'scroll', 'wheel', 'drag', 'dragover', 'selectionchange', 'timeupdate']);
const PSEUDO: ReadonlySet<string> = new Set(['every', 'page-ready', 'view-enter', 'view-leave']);
/**
 * Events a program can cause by itself, at the speed of a transition or a frame, too
 * slow for any rate to catch and able to go round for ever.
 */
const SELF_CAUSED = /^(?:transition|animation|view-|toggle$|beforetoggle$|close$|cancel$)/;
const PERSON: readonly string[] = ['pointerdown', 'keydown', 'wheel', 'touchmove'];
const REPLAYED: readonly string[] = ['set', 'toggle', 'step'];
const NO_ENTRIES: readonly ProgramEntry[] = [];

/** A sum over a missing value is no value, and reaches no page as the word NaN. */
const hasValue = (value: unknown): boolean => value !== undefined && !Number.isNaN(value);
const hasVerb = (action: Action, verbs: readonly string[]): boolean => verbs.some((verb) => verb in action);

export function startBehaviour({ container, program, nodeAttr = NODE_ATTR, surface, verbs, keys }: StartBehaviourOptions): () => void {
  const doc = (container.ownerDocument ?? container) as Document;
  const view = doc.defaultView as Window & typeof globalThis;
  const entries = new Map(Object.entries(program.nodes));
  const selector = `[${nodeAttr}],[${SCOPE_ATTR}]`;
  /** What queries start from. Stored content lives under it, so a document's own methods are never called. */
  const top = isElement(container) ? container : doc.documentElement;

  const scopes = new WeakMap<Element, Map<string, Cell>>();
  const kept = new Map<string, Map<string, Cell>>();
  const bound = new Set<Element>();
  const usage = new Map<ProgramTrigger, Usage>();
  const warned = new Set<string>();
  const pending = new WeakMap<Element, Map<string, number>>();
  const timers = new Set<number>();
  const seen = new WeakSet<Element>();
  const adopted = new WeakSet<Element>();
  const stops: (() => void)[] = [];
  const held = new Map<string, Event>();
  const opening: [Element, ProgramTrigger][] = [];

  let stopped = false;
  let dirty = false;
  let frame = 0;
  let taskActions = 0;
  let pageStart = 0;
  let pageCost = 0;
  let timersOff = false;
  let prompts = 0;
  let intersection: IntersectionObserver | null = null;

  const warn = (message: string, id: string): void => {
    if (warned.has(message + id)) return;
    warned.add(message + id);
    console.warn(`Page behaviour: ${message}`, id);
  };

  const stopTimers = (): void => {
    timers.forEach((id) => {
      view.clearTimeout(id);
      view.clearInterval(id);
    });
    timers.clear();
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    stops.forEach((run) => run());
    stopTimers();
    if (frame) view.cancelAnimationFrame(frame);
  };

  const gate = (): Gate | undefined =>
    surface === 'published' ? (view as unknown as Record<string, Gate | undefined>)[GATE_GLOBAL] : undefined;

  /** Everything that runs later goes through here, so nothing escapes to the page. */
  const guarded = <A extends unknown[]>(work: (...args: A) => void) => (...args: A): void => {
    if (stopped) return;
    try {
      work(...args);
    } catch (error) {
      console.error('Page behaviour stopped', error);
      stop();
      gate()?.fail();
    }
  };

  // ---- nodes -------------------------------------------------------------

  const entriesOf = (el: Element): readonly ProgramEntry[] => entries.get(attrOf(el, nodeAttr) ?? '') ?? NO_ENTRIES;
  const entryOf = (el: Element): ProgramEntry | undefined => entriesOf(el)[Number(attrOf(el, VARIANT_ATTR) ?? 0)];

  /** The nearest node holding `key`, scope by scope, so a row finds its own. The page is the last scope. */
  const find = (key: string, from: Element): Element | null => {
    const match = `[${nodeAttr}="${key}"]`;
    for (const scope of upFrom(from)) {
      if (!hasAttr(scope, SCOPE_ATTR)) continue;
      const hit = isMatch(scope, match) ? scope : one(scope, match);
      if (hit) return hit;
    }
    return one(top, match);
  };

  /** A scope's place on the page, which survives an island remounting it. */
  const pathOf = (el: Element): string => {
    const path: string[] = [];
    for (const at of upFrom(el)) {
      if (!hasAttr(at, SCOPE_ATTR)) continue;
      const parent = parentOf(at);
      path.push(`${attrOf(at, nodeAttr)}:${attrOf(at, ROW_ATTR) ?? (parent ? [...childrenOf(parent)].indexOf(at) : 0)}`);
    }
    return path.join('/');
  };

  // ---- state -------------------------------------------------------------

  const cellOf = (id: string, from: Element): { scope: Element; cell: Cell } | null => {
    for (const at of upFrom(from)) {
      const cell = scopes.get(at)?.get(id);
      if (cell) return { scope: at, cell };
    }
    return null;
  };

  const reflect = (scope: Element, { state, value }: Cell): void => {
    if (state.type !== 'text') setAttr(scope, stateAttribute(state.id), String(value));
  };

  /** The value a state may hold, or undefined when `value` is not one. */
  const fit = (state: ProgramState, value: unknown): unknown => {
    if (state.type === 'boolean') return typeof value === 'boolean' ? value : undefined;
    if (state.type === 'choice') return state.options.includes(value as string) ? value : undefined;
    if (state.type === 'text') return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, state.maxLength ?? MAX_TEXT) : undefined;
    const number = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
    if (!Number.isFinite(number)) return undefined;
    return Math.min(state.max ?? Infinity, Math.max(state.min ?? -Infinity, Math.round(number * NUMBER_PRECISION) / NUMBER_PRECISION));
  };

  const touch = (): void => {
    if (dirty) return;
    dirty = true;
    queueMicrotask(flush);
  };

  /** True when the value changed. One that does not fit is dropped. */
  const write = (id: string, value: unknown, from: Element): boolean => {
    const found = cellOf(id, from);
    if (!found) {
      warn('no state', id);
      return false;
    }
    const next = fit(found.cell.state, value);
    if (next === undefined || next === found.cell.value) return false;
    found.cell.value = next;
    reflect(found.scope, found.cell);
    touch();
    return true;
  };

  const read = (id: string, from: Element): unknown => cellOf(id, from)?.cell.value;

  // ---- expressions -------------------------------------------------------

  const rowOf = (el: Element): number | undefined => {
    const clone = closestTo(el, `[${ROW_ATTR}]`);
    return clone ? Number(attrOf(clone, ROW_ATTR)) : undefined;
  };

  const pointerAt = (x: Extract<Expression, { pointer: string }>, run: Pick<Run, 'el' | 'event'>): number | undefined => {
    const target = find(x.of, run.el);
    const event = run.event as PointerEvent | null;
    if (!target || !event) return undefined;
    const box = target.getBoundingClientRect();
    const across = x.pointer === 'x';
    const raw = across ? event.clientX - box.left : event.clientY - box.top;
    const size = across ? box.width : box.height;
    if (x.as === 'px') return raw;
    return size > 0 ? Math.round((raw / size) * 100) : undefined;
  };

  /** A range's value is a number, which the DOM hands over as text. */
  const eventValue = (el: Element): unknown => {
    const { value, type } = el as HTMLInputElement;
    return type === 'range' ? Number(value) : value;
  };

  /** One expression or condition. Total: every form has a value, undefined when there is none. */
  const evaluate = (x: unknown, run: Pick<Run, 'el' | 'event'>): unknown => {
    if (typeof x !== 'object' || x === null) return x;
    const all = (list: unknown): unknown[] => (list as unknown[]).map((entry) => evaluate(entry, run));
    const numbers = (list: unknown): number[] => all(list).map(Number);
    const form = x as Record<string, unknown>;
    if ('get' in form) return read(form.get as string, run.el);
    if ('state' in form) return read(form.state as string, run.el) === evaluate(form.eq, run);
    if ('eq' in form) {
      const [a, b] = all(form.eq);
      return a === b;
    }
    if ('not' in form) return !evaluate(form.not, run);
    if ('and' in form) return all(form.and).every(Boolean);
    if ('all' in form) return all(form.all).every(Boolean);
    if ('or' in form) return all(form.or).some(Boolean);
    if ('any' in form) return all(form.any).some(Boolean);
    if ('gt' in form) {
      const [a, b] = numbers(form.gt);
      return a > b;
    }
    if ('lt' in form) {
      const [a, b] = numbers(form.lt);
      return a < b;
    }
    if ('add' in form) {
      const [a, b] = numbers(form.add);
      return a + b;
    }
    if ('clamp' in form) {
      const [value, low, high] = numbers(form.clamp);
      return Math.min(high, Math.max(low, value));
    }
    if ('map' in form) {
      const cases = form.cases as Record<string, unknown>;
      const key = String(read(form.map as string, run.el));
      return evaluate(Object.hasOwn(cases, key) ? cases[key] : form.default, run);
    }
    if ('row' in form) return rowOf(run.el);
    if ('pointer' in form) return pointerAt(x as Extract<Expression, { pointer: string }>, run);
    if ('event' in form) {
      if (form.event === 'value') return eventValue(run.el);
      return (run.event as unknown as Record<string, unknown> | null)?.[form.event === 'key' ? 'key' : 'newState'];
    }
    return undefined;
  };

  // ---- bindings ----------------------------------------------------------

  const applyAttribute = (el: Element, attr: string, value: unknown): void => {
    if (isBooleanAttribute(attr)) {
      toggleAttr(el, attr, Boolean(value));
      return;
    }
    const text = String(value);
    if (attrOf(el, attr) !== text) setAttr(el, attr, text);
    // The attribute is only the first value of a field a person has touched.
    if (attr === 'value' && 'value' in el && (el as HTMLInputElement).value !== text) (el as HTMLInputElement).value = text;
  };

  const applyBinding = (el: Element, binding: ProgramBinding): void => {
    const run = { el, event: null };
    if ('text' in binding) {
      const value = evaluate(binding.text, run);
      // Only an element holding its one text child: React keeps that through hydration.
      if (hasValue(value) && el.childElementCount === 0 && el.textContent !== String(value)) el.textContent = String(value);
      return;
    }
    const value = evaluate(binding.from, run);
    if (!hasValue(value)) return;
    if ('attr' in binding) {
      applyAttribute(el, binding.attr, value);
      return;
    }
    const number = Number(value);
    if (Number.isFinite(number)) (el as HTMLElement).style.setProperty(binding.cssVar, `${number}${binding.unit ?? ''}`);
  };

  const flush = guarded((): void => {
    dirty = false;
    charge(bound.size);
    for (const el of bound) {
      if (!isConnected(el)) bound.delete(el);
      else for (const binding of entryOf(el)?.bind ?? []) applyBinding(el, binding);
    }
  });

  // ---- budget ------------------------------------------------------------

  const usageOf = (trigger: ProgramTrigger): Usage => {
    let use = usage.get(trigger);
    if (!use) {
      use = { start: 0, count: 0, off: false, unprompted: 0, prompt: 0 };
      usage.set(trigger, use);
    }
    return use;
  };

  /**
   * Charges the page for work. Many small triggers can each stay under their own limit,
   * so past the page's limit nothing runs until the second is over, and timers stop for
   * the visit: what a person does comes back, and what nobody asked for does not.
   */
  const charge = (cost: number): boolean => {
    const now = view.performance.now();
    if (now - pageStart > 1000) {
      pageStart = now;
      pageCost = 0;
    }
    pageCost += cost;
    if (pageCost <= MAX_PAGE_COST_PER_SECOND) return true;
    if (!timersOff) {
      timersOff = true;
      stopTimers();
      warn('too much at once, timers off', 'page');
    }
    return false;
  };

  /** Charges one action. False once the trigger went over, which turns it off for good. */
  const spend = (trigger: ProgramTrigger): boolean => {
    const use = usageOf(trigger);
    if (use.off || !charge(1)) return false;
    const now = view.performance.now();
    if (now - use.start > 1000) {
      use.start = now;
      use.count = 0;
    }
    use.count += 1;
    if (taskActions === 0) queueMicrotask(() => { taskActions = 0; });
    taskActions += 1;
    if (use.count <= MAX_ACTIONS_PER_SECOND && taskActions <= MAX_ACTIONS_PER_TASK) return true;
    use.off = true;
    warn('ran too often', trigger.id);
    return false;
  };

  const refund = (trigger: ProgramTrigger): void => {
    usageOf(trigger).count -= 1;
    taskActions -= 1;
    pageCost -= 1;
  };

  /** False when a trigger on what the page caused has gone round too long with nobody there. */
  const prompted = (trigger: ProgramTrigger): boolean => {
    if (!SELF_CAUSED.test(trigger.on)) return true;
    const use = usageOf(trigger);
    if (use.prompt !== prompts) {
      use.prompt = prompts;
      use.unprompted = 0;
    }
    use.unprompted += 1;
    if (use.unprompted <= MAX_UNPROMPTED_FIRINGS) return true;
    use.off = true;
    warn('ran unprompted too long', trigger.id);
    return false;
  };

  const kit: Kit = {
    container,
    doc,
    surface,
    find,
    entryOf,
    evaluate,
    warn,
    charge,
    settle: () => {
      if (dirty) flush();
    },
  };
  const runVerb = verbs?.(kit);

  // ---- actions -----------------------------------------------------------

  /** Where a `delay` key lives: the nearest scope that already holds it, or the nearest scope. */
  const holderOf = (key: string, from: Element): Element => {
    for (const at of upFrom(from)) {
      if (pending.get(at)?.has(key)) return at;
    }
    return closestTo(from, `[${SCOPE_ATTR}]`) ?? from;
  };

  const cancel = (key: string, from: Element): boolean => {
    const keys = pending.get(holderOf(key, from));
    const id = keys?.get(key);
    if (id === undefined) return false;
    view.clearTimeout(id);
    timers.delete(id);
    keys?.delete(key);
    return true;
  };

  const schedule = (action: Extract<Action, { delay: number }>, run: Run): void => {
    if (timersOff) return;
    const holder = action.key ? holderOf(action.key, run.el) : null;
    const { key } = action;
    if (key) cancel(key, run.el);
    const id: number = view.setTimeout(guarded(() => {
      timers.delete(id);
      if (key && holder) pending.get(holder)?.delete(key);
      perform(action.do, run);
    }), action.delay);
    timers.add(id);
    if (key && holder) pending.set(holder, (pending.get(holder) ?? new Map<string, number>()).set(key, id));
  };

  const step = (action: Extract<Action, { step: string }>, run: Run): boolean => {
    const found = cellOf(action.step, run.el);
    if (!found) return write(action.step, undefined, run.el);
    const { state, value } = found.cell;
    const by = action.by ?? 1;
    if (state.type === 'choice') {
      const { options } = state;
      const at = options.indexOf(value as string) + by;
      const index = action.wrap ? (at + options.length) % options.length : Math.min(options.length - 1, Math.max(0, at));
      return write(action.step, options[index], run.el);
    }
    if (state.type !== 'number') return false;
    const next = (value as number) + by * (state.step ?? 1);
    if (action.wrap && state.max !== undefined && next > state.max) return write(action.step, state.min ?? next, run.el);
    if (action.wrap && state.min !== undefined && next < state.min) return write(action.step, state.max ?? next, run.el);
    return write(action.step, next, run.el);
  };

  /** Fires `custom:<name>` on the node and up the nodes around it. */
  const emit = (name: string, run: Run): void => {
    if (run.depth >= MAX_EMIT_DEPTH) {
      warn('emit too deep', name);
      return;
    }
    const type = `custom:${name}`;
    for (const at of upFrom(run.el)) {
      for (const trigger of entryOf(at)?.on ?? []) {
        if (trigger.on === type) fire(trigger, at, null, run.depth + 1);
      }
    }
  };

  /** Runs one action. False when it left everything as it was, so it costs nothing. */
  const act = (action: Action, run: Run): boolean => {
    if ('set' in action) return write(action.set, evaluate(action.value, run), run.el);
    if ('toggle' in action) return write(action.toggle, !read(action.toggle, run.el), run.el);
    if ('step' in action) return step(action, run);
    if ('cancel' in action) return cancel(action.cancel, run.el);
    if ('delay' in action) schedule(action, run);
    else if ('emit' in action) emit(action.emit, run);
    else if (runVerb) runVerb(action, run);
    else warn('no such action', run.trigger.id);
    return true;
  };

  const perform = (actions: readonly Action[], run: Run): void => {
    for (const action of actions) {
      if (!spend(run.trigger)) return;
      if (run.replay && !hasVerb(action, REPLAYED)) {
        refund(run.trigger);
        continue;
      }
      if (!act(action, run)) refund(run.trigger);
    }
  };

  // ---- triggers ----------------------------------------------------------

  const fire = (trigger: ProgramTrigger, el: Element, event: Event | null, depth: number, replay = false): void => {
    if (usageOf(trigger).off || !prompted(trigger)) return;
    if ((trigger.on === 'keydown' || trigger.on === 'keyup') && !keys?.keysAnswer(trigger.keys, event as KeyboardEvent, el)) return;
    if (trigger.if !== undefined && !evaluate(trigger.if, { el, event })) return;
    if (trigger.prevent && !replay) event?.preventDefault();
    perform(trigger.do, { el, event, trigger, depth, replay });
  };

  const fireOn = (el: Element, type: string, event: Event | null, replay = false): void => {
    for (const trigger of entryOf(el)?.on ?? []) {
      if (trigger.on === type && trigger.scope !== 'document') fire(trigger, el, event, 0, replay);
    }
  };

  /** The element an event starts from. `selectionchange` targets the document. */
  const originOf = (event: Event): Element | null => {
    if (isElement(event.target)) return event.target;
    if (event.type !== 'selectionchange') return null;
    const anchor = doc.getSelection()?.anchorNode ?? null;
    if (!anchor) return null;
    return isElement(anchor) ? anchor : parentOf(anchor as Element);
  };

  const deliver = (event: Event, replay = false): void => {
    const origin = originOf(event);
    if (!origin || !holds(container, origin)) return;
    if (!event.bubbles && event.type !== 'selectionchange') {
      fireOn(origin, event.type, event, replay);
      return;
    }
    for (const at of upFrom(origin)) fireOn(at, event.type, event, replay);
  };

  /** A frame's document hears other frames too, so on one the event has to be its own. */
  const isOurs = (event: Event): boolean => {
    if (container === doc) return true;
    const anchor = doc.getSelection()?.anchorNode ?? null;
    return holds(container, event.target as Node) || (anchor !== null && holds(container, anchor));
  };

  const pageWide = new Map<string, [string, ProgramTrigger][]>();

  const deliverPageWide = (event: Event): void => {
    if (!isOurs(event)) return;
    for (const [key, trigger] of pageWide.get(event.type) ?? []) {
      for (const el of every(top, `[${nodeAttr}="${key}"]`)) {
        if (entryOf(el)?.on?.includes(trigger)) fire(trigger, el, event, 0);
      }
    }
  };

  const hear = (event: Event): void => {
    deliver(event);
    deliverPageWide(event);
  };

  /** What waits for a frame runs first, so a release always follows the last move. */
  const drain = (): void => {
    if (frame) view.cancelAnimationFrame(frame);
    frame = 0;
    const events = [...held.values()];
    held.clear();
    events.forEach(hear);
  };

  const hold = (event: Event): void => {
    held.set(event.type, event);
    if (!frame) frame = view.requestAnimationFrame(guarded(drain));
  };

  const listen = (type: string, batched: boolean, prevents: boolean): void => {
    const work = guarded(batched
      ? hold
      : (event: Event) => {
          if (held.size > 0) drain();
          hear(event);
        });
    const options: AddEventListenerOptions = { capture: true, passive: HIGH_FREQUENCY.has(type) ? !prevents : undefined };
    // What targets the document, or hears all of it, is out of a frame's reach.
    const target: EventTarget = pageWide.has(type) || type === 'selectionchange' ? doc : container;
    target.addEventListener(type, work, options);
    stops.push(() => target.removeEventListener(type, work, options));
  };

  const startEvery = (el: Element, trigger: ProgramTrigger): void => {
    if (timersOff) return;
    const motion = view.matchMedia?.('(prefers-reduced-motion: reduce)');
    const id = view.setInterval(guarded(() => {
      if (!isConnected(el)) {
        view.clearInterval(id);
        timers.delete(id);
      } else if (!doc.hidden && !motion?.matches) {
        fire(trigger, el, null, 0);
      }
    }), trigger.ms);
    timers.add(id);
  };

  const watch = (el: Element): void => {
    intersection ??= typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(guarded((records: IntersectionObserverEntry[]) => {
          for (const { target, isIntersecting } of records) {
            if (isIntersecting) seen.add(target);
            else if (!seen.has(target)) continue;
            else seen.delete(target);
            fireOn(target, isIntersecting ? 'view-enter' : 'view-leave', null);
          }
        }))
      : null;
    intersection?.observe(el);
  };

  // ---- the page ----------------------------------------------------------

  /** Takes on one marked element, once. */
  const adopt = (el: Element): void => {
    const entry = entryOf(el);
    if (!entry || adopted.has(el)) return;
    adopted.add(el);
    if (entry.state) {
      const path = pathOf(el);
      let cells = kept.get(path);
      if (cells) cells.forEach((cell) => reflect(el, cell));
      else {
        cells = new Map(entry.state.map((state) => [state.id, { state, value: state.initial }]));
        kept.set(path, cells);
      }
      scopes.set(el, cells);
    }
    if (entry.bind) bound.add(el);
    if (entry.on?.some(({ on }) => on.startsWith('view-'))) watch(el);
    for (const trigger of entry.on ?? []) {
      if (trigger.on === 'every') startEvery(el, trigger);
      if (trigger.on === 'toggle') opening.push([el, trigger]);
    }
  };

  const scan = (root: Element): void => {
    if (isMatch(root, selector)) adopt(root);
    every(root, selector).forEach(adopt);
  };

  /** What was opened before the runtime started, which fired a `toggle` nobody heard. */
  const catchUp = (): void => {
    for (const [el, trigger] of opening.splice(0)) {
      if (hasAttr(el, 'open') || (attrOf(el, 'popover') !== null && isMatch(el, ':popover-open'))) {
        fire(trigger, el, { newState: 'open' } as unknown as Event, 0, true);
      }
    }
  };

  /** Presses held by the boot script: state verbs only, since the native action already ran. */
  const replay = (queue: Event[]): void => {
    for (const event of queue.splice(0)) {
      const target = event.target as Element | null;
      if (!target || !isConnected(target) || (event.type === 'keydown' && keys?.isTextEntry(target))) continue;
      deliver(event, true);
    }
  };

  const begin = (): void => {
    for (const [key, list] of entries) {
      for (const entry of list) {
        for (const trigger of entry.on ?? []) {
          if (trigger.scope === 'document') pageWide.set(trigger.on, [...(pageWide.get(trigger.on) ?? []), [key, trigger]]);
        }
      }
    }
    const triggers = [...entries.values()].flatMap((list) => list.flatMap((entry) => entry.on ?? []));
    if (triggers.some(({ on }) => SELF_CAUSED.test(on))) {
      const person = () => {
        prompts += 1;
      };
      for (const type of PERSON) {
        doc.addEventListener(type, person, { capture: true, passive: true });
        stops.push(() => doc.removeEventListener(type, person, { capture: true }));
      }
    }
    for (const type of new Set(triggers.map((trigger) => trigger.on))) {
      if (PSEUDO.has(type) || type.startsWith('custom:')) continue;
      const prevents = triggers.some((trigger) => trigger.on === type && trigger.prevent === true);
      listen(type, HIGH_FREQUENCY.has(type) && !prevents, prevents);
    }

    scan(top);
    const mutations = new MutationObserver(guarded((records: MutationRecord[]) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (isElement(node)) scan(node);
        });
      }
      touch();
    }));
    mutations.observe(container, { childList: true, subtree: true });
    stops.push(() => mutations.disconnect(), () => intersection?.disconnect());

    const page = gate();
    if (page && !page.ready()) {
      stop();
      return;
    }
    flush();
    if (page) replay(page.queue);
    catchUp();
    for (const el of every(top, `[${nodeAttr}]`)) fireOn(el, 'page-ready', null);
  };

  guarded(begin)();
  return stop;
}
