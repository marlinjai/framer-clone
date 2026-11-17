// src/lib/customCode/broker.ts
//
// The broker of sandboxed custom code: the behaviour runtime's third lazy chunk,
// fetched only by a page that holds a block (BehaviourIsland, `program.broker`).
// Plan docs/plans/2026-11-02-sandboxed-custom-code.md, "The postMessage contract",
// and decisions D8 and D60 onward.
//
// For each block an island adds (registry.ts) it:
//
//   - creates the frame once the box is within one viewport of the screen, with
//     constant attributes only: `sandbox="allow-scripts"` and the rest are set
//     before the address, and the address is the server's (built from the
//     rendering site's id and the hash) and checked once more here;
//   - accepts `hello` only from that frame's own window (`source`), with the
//     opaque origin a sandboxed frame has, once; a second `hello` or a second
//     `load` of the frame removes it, and so does no `hello` within 5 seconds of
//     the frame's `load`;
//   - transfers one port of a MessageChannel with `connect`, and from then on
//     reads only that port, under every rule of the protocol: at most 64
//     kilobytes and 30 messages a second, a declared write of the right type
//     within `min`, `max` and `options`, never `text` state, a declared
//     `custom:<name>` (which runs state verbs only, Kit.emit), `resize` only for
//     `sizing: 'content'`, 10 a second, up to 10,000 pixels; anything else is
//     dropped with a console warning naming the block;
//   - sends each declared read at `connect` and on every change, read from the
//     `data-fcs-<id>` attribute the runtime reflects on the state's scope, which
//     is never written for `text` state;
//   - pings every 5 seconds, and removes a frame that left three pings unanswered;
//   - removes an interactive frame that took the keyboard three times while the
//     pointer was not over it and no Tab was pressed in the page, and a frame that
//     is not interactive the first time (decision D8, see the plan, "Decided in slice C3").
//
// Whatever a frame does, the page goes on: every failure takes the frame away and
// leaves the fallback, for good. At most 4 blocks per page.
//
// PURE and client-safe: no React. Imports leaves only, for the size limit
// (2 kilobytes gzipped on Next's real chunk, test/behaviour/runtime.spec.ts).

import type { Kit } from '@/lib/behaviour/program';
import { stateAttribute } from '@/lib/behaviour/names';
import { serveBlocks, type BlockHandle, type BlockState } from './registry';

// The protocol's numbers, as contract.ts (BOX_LIMITS) states them; the bridge tests in the
// browser hold each one. Local constants, not imports or exports: every name is bytes in a
// chunk with a 2 kilobyte limit, and contract.ts would bring more than these.
const BLOCKS_PER_PAGE = 4;
const HELLO_MS = 5000;
const PING_MS = 5000;
const MISSED_PINGS = 3;
const MESSAGE_BYTES = 64 * 1024;
const MESSAGES_PER_SECOND = 30;
const RESIZES_PER_SECOND = 10;
const MAX_HEIGHT = 10_000;
const FOCUS_THEFTS = 3;
/** A Tab in the page this long before the frame took the keyboard explains the move. */
const TAB_GRACE_MS = 1000;

/** The only address a frame may have: the box's path for one site and one hash. */
const BOX_SRC = /^https:\/\/[a-z0-9.-]+\/box\/[0-9a-f-]{36}\/[0-9a-f]{64}$/;

/** True when `value` may be written to a state of this definition. Strict: no coercion, no clamping, never `text`. */
export const fits = (state: BlockState | undefined, value: unknown): boolean =>
  state?.type === 'boolean'
    ? typeof value === 'boolean'
    : state?.type === 'number'
      ? typeof value === 'number' && Number.isFinite(value) && !(value < (state.min as number)) && !(value > (state.max as number))
      : state?.type === 'choice' && (state.options ?? []).includes(value as string);

/** A count per second: true once it goes past `limit` in the current second. */
const meter = (limit: number, now: () => number) => {
  let start = -Infinity;
  let count = 0;
  return (): boolean => {
    if (now() - start > 1000) {
      start = now();
      count = 0;
    }
    return ++count > limit;
  };
};

export const createBroker = (kit: Kit): (() => void) => {
  const doc = kit.doc;
  const view = doc.defaultView as Window;
  const now = () => view.performance.now();
  const frames = new Map<Element, () => void>();
  let blocks = 0;
  let tabAt = -Infinity;

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') tabAt = now();
  };
  // The page's window loses focus when a frame takes it; which frame holds it is known a task later.
  const onBlur = (): void => {
    view.setTimeout(() => frames.get(doc.activeElement as Element)?.());
  };
  view.addEventListener('keydown', onKey, true);
  view.addEventListener('blur', onBlur);

  const serve = ({ el, block, settle }: BlockHandle): (() => void) => {
    const { title, reads, writes, emits, sizing, interactive, states } = block;
    const say = (why: string): void => console.warn(`Custom code "${title}": ${why}`);
    if (blocks >= BLOCKS_PER_PAGE || !BOX_SRC.test(block.src)) {
      say('over 4 blocks, or not a box address: fallback');
      settle(false);
      return () => {};
    }
    blocks += 1;
    let frame: HTMLIFrameElement | undefined;
    let port: MessagePort | undefined;
    let gone = false;
    let hello = false;
    let loads = 0;
    let missed = 0;
    let thefts = 0;
    let timer = 0;
    let pinger = 0;
    const tooMany = meter(MESSAGES_PER_SECOND, now);
    const tooOften = meter(RESIZES_PER_SECOND, now);
    const scopeOf = (id: string) => el.closest(`[${stateAttribute(id)}]`);
    const watcher = new MutationObserver((records) => records.forEach((record) => send((record.attributeName as string).slice(9))));
    // Within one viewport of the screen, in any direction.
    const near = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && create(), { rootMargin: '100%' });

    const end = (why?: string): void => {
      if (gone) return;
      gone = true;
      if (why) say(`${why}: removed`);
      view.clearTimeout(timer);
      view.clearInterval(pinger);
      near.disconnect();
      watcher.disconnect();
      view.removeEventListener('message', onMessage);
      port?.close();
      if (frame) {
        frames.delete(frame);
        frame.remove();
      }
      settle(false);
    };

    const post = (message: Record<string, unknown>): void => port?.postMessage(message);

    /** A declared read's value as its scope shows it. Nothing for any other state, `text` above all. */
    const send = (id: string): void => {
      const type = states[id]?.type;
      const text = scopeOf(id)?.getAttribute(stateAttribute(id));
      const value = type === 'boolean' ? text === 'true' : type === 'number' ? Number(text) : type === 'choice' ? text : null;
      if (reads.includes(id) && text != null && value != null) post({ kind: 'state', id, value });
    };

    /** One message on the port, under every rule of the protocol. */
    const onPort = ({ data }: MessageEvent): void => {
      if (tooMany()) return say('over 30 messages a second, dropped');
      let size = Infinity;
      try {
        size = new Blob([JSON.stringify(data)]).size;
      } catch {
        // Not something JSON can say: dropped below.
      }
      if (!(size <= MESSAGE_BYTES)) return say('a message over 64 KB or not JSON, dropped');
      const kind = data?.kind;
      if (kind === 'pong') missed = 0;
      else if (kind === 'setState' && writes.includes(data.id) && fits(states[data.id], data.value)) kit.write(data.id, data.value, el);
      else if (kind === 'emit' && emits.includes(data.name)) kit.emit(data.name.slice(7), el);
      else if (kind === 'resize' && sizing === 'content' && !tooOften() && typeof data.height == 'number' && data.height >= 0) {
        (frame as HTMLIFrameElement).style.height = `${Math.min(data.height, MAX_HEIGHT)}px`;
      } else say(kind === 'error' ? `error: ${String(data.message).slice(0, 500)}` : 'a message undeclared, of a wrong value or an unknown kind, dropped');
    };

    const onMessage = (event: MessageEvent): void => {
      if (!frame || event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.fc !== 1 || event.data.kind !== 'hello') return;
      if (hello) return end('a second hello');
      hello = true;
      view.clearTimeout(timer);
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = onPort;
      (frame.contentWindow as Window).postMessage({ fc: 1, kind: 'connect', declaration: { reads, writes, emits, sizing, interactive } }, '*', [channel.port2]);
      frame.style.position = frame.style.visibility = '';
      frame.style.width = '100%';
      settle(true);
      // Each scope once, with every read: observing a node again would replace its filter.
      const filter = reads.map(stateAttribute);
      new Set(reads.map(scopeOf)).forEach((scope) => scope && watcher.observe(scope, { attributeFilter: filter }));
      reads.forEach(send);
      pinger = view.setInterval(() => {
        if (missed >= MISSED_PINGS) return end('3 pings unanswered');
        missed += 1;
        post({ kind: 'ping' });
      }, PING_MS);
    };

    const create = (): void => {
      near.disconnect();
      if (frame || gone) return;
      const made = (frame = doc.createElement('iframe'));
      // Constants only, and the sandbox before anything else; the address comes last.
      for (const [name, value] of [['sandbox', 'allow-scripts'], ['referrerpolicy', 'no-referrer'], ['loading', 'lazy'], ['allow', ''], ['title', title]]) {
        made.setAttribute(name, value);
      }
      const minimum = parseFloat(view.getComputedStyle(el).minHeight);
      // Hidden until hello, but laid out at the box's width, so a lazy frame still loads and the page does not widen.
      made.style.cssText = `border:0;display:block;position:absolute;visibility:hidden;width:${el.clientWidth || 300}px;height:${sizing === 'fixed' ? '100%' : `${minimum > 0 ? minimum : 150}px`}`;
      if (!interactive) {
        made.style.pointerEvents = 'none';
        made.tabIndex = -1;
      }
      made.addEventListener('load', () => {
        if (++loads > 1) return end('loaded a second time');
        if (!hello) timer = view.setTimeout(() => end('no hello within 5 s'), HELLO_MS);
      });
      view.addEventListener('message', onMessage);
      frames.set(made, () => {
        if (!interactive) return end('took the keyboard');
        if (!made.matches(':hover') && now() - tabAt > TAB_GRACE_MS && ++thefts >= FOCUS_THEFTS) end('took the keyboard 3 times');
      });
      made.src = block.src;
      el.appendChild(made);
    };

    near.observe(el);
    return () => {
      blocks -= 1;
      end();
    };
  };

  const stop = serveBlocks(serve);
  return () => {
    stop();
    view.removeEventListener('keydown', onKey, true);
    view.removeEventListener('blur', onBlur);
  };
};
