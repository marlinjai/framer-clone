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
//     rendering site's id and the hash), which the page's policy alone admits;
//   - accepts `hello` only from that frame's own window (`source`), with the
//     opaque origin a sandboxed frame has, once; a second `hello` or a second
//     `load` of the frame removes it, and so does no `hello` within 5 seconds of
//     the frame's `load`;
//   - transfers one port of a MessageChannel with `connect`, and from then on
//     reads only that port, under every rule of the protocol: plain data of at
//     most 64 kilobytes as JSON, 30 messages a second (counted with the frame's
//     window messages; past 90 the frame is removed), a declared write of the
//     right type within `min`, `max` and `options`, never `text` state, a declared
//     `custom:<name>` (which runs state verbs only, Kit.emit), `resize` only for
//     `sizing: 'content'`, among the second's first 10 messages, up to 10,000
//     pixels; anything else is dropped, with one console warning a frame;
//   - sends each declared read at `connect` and on every change, read from the
//     `data-fcs-<id>` attribute the runtime reflects on the state's scope, which
//     is never written for `text` state;
//   - pings every 5 seconds, and removes a frame that left three pings unanswered;
//   - removes an interactive frame that took the keyboard three times while the
//     visitor was typing in the page, or while the pointer was not over it and no
//     Tab was pressed in the page, and a frame that is not interactive the first
//     time (decisions D8 and D71, see the plan, "Decided in slice C3").
//
// Whatever a frame does, the page goes on: every failure takes the frame away and
// leaves the fallback, for good. At most 4 blocks per page.
//
// PURE and client-safe: no React. Imports leaves only, for the size limit
// (2 kilobytes gzipped on Next's real chunk, test/behaviour/runtime.spec.ts).

import type { Kit } from '@/lib/behaviour/program';
import { stateAttribute } from '@/lib/behaviour/names';
import { serveBlocks, type BlockHandle, type BlockState } from './registry';

// The protocol's numbers, as contract.ts (BOX_LIMITS) states them, are written where they are
// used: at most 4 blocks a page; `hello` within 5 s of `load`; a ping every 5 s, 3 missed remove
// the frame; 64 KB and 30 messages a second, 90 remove the frame; resizes among a second's first 10
// messages, up to 10,000 pixels; 3 thefts of the keyboard; a Tab in the page within 1 s explains a
// move, typing in it within 0.5 s does not. Literals, not names: esbuild
// keeps a module's constants as variables, and every byte counts against the 2 kilobyte limit.
// The bridge tests in the browser hold each number.

/** True when `value` may be written to a state of this definition. Strict: no coercion, no clamping, never `text`. */
export const fits = (state: BlockState | undefined, value: unknown): boolean => {
  if (!state) return false;
  const { type, min, max, options } = state;
  return type === 'boolean'
    ? typeof value === 'boolean'
    : type === 'number'
      ? typeof value === 'number' && Number.isFinite(value) && !(value < (min as number)) && !(value > (max as number))
      : type === 'choice' && !!options && options.includes(value as string);
};

/**
 * JSON.stringify's replacer for a frame's message: throws at anything but plain data. A cloned plain object or
 * array has its realm's Object or Array as constructor; a Map, a Set, a buffer, a typed array or a Blob has its
 * own (and an own `constructor` key holding something else is refused with them). A cycle or a bigint makes JSON.stringify throw itself.
 * A Date reaches it as its string (toJSON runs first), which is plain.
 */
const plain = (_: string, value: unknown): unknown => {
  const kind = value && (value as object).constructor;
  // `kind` is null for null, and for a primitive its wrapper, which `typeof` leaves out.
  if (kind && kind != Object && kind != Array && typeof value == 'object') throw 0;
  return value;
};

export const createBroker = (kit: Kit): (() => void) => {
  const doc = kit.doc;
  // The page's own window: the runtime runs in it, so its globals are the page's.
  const now = () => performance.now();
  const frames = new Map<Element, (late: boolean) => void>();
  let blocks = 0;
  let tabAt = -Infinity;
  let typedAt = -Infinity;

  /**
   * A person's move: a Tab in the page, or the pointer entering a frame. And typing: a key other than Tab
   * in the page, which a Tab forgets (it moves the keyboard on purpose).
   */
  const onKey = (event: Event): void => {
    const key = (event as KeyboardEvent).key;
    if (event.type[0] == 'p' || key == 'Tab') tabAt = now();
    typedAt = key == 'Tab' ? -Infinity : key ? now() : typedAt;
  };
  // Where the keyboard went is read a task after any focus or blur in the page, the window's own
  // included (caught in the capture phase): Chromium blurs the window when a frame takes the keyboard,
  // Firefox only blurs the element that had it (both measured in the bridge tests). Each arrival in a
  // frame counts once. The page holding the keyboard is noted at once, in the event: a frame running in
  // the page's process (Firefox) can take it back before that task runs, and that arrival must count.
  // An engine may also hold the event back until the page's next focus change (Firefox as Playwright runs
  // it), so every ping looks as well: a theft no event announces is still seen within 5 seconds. Seen
  // that late, a person's own move needs as long to explain it (see the frame's check below).
  let last: Element | null = null;
  const onFocus = (late: unknown): void => {
    if (!frames.has(doc.activeElement as Element)) last = doc.activeElement;
    setTimeout(() => {
      const at = doc.activeElement;
      const check = at !== last && frames.get((last = at) as Element);
      if (check) check(late === true);
    });
  };
  addEventListener('keydown', onKey, true);
  addEventListener('focus', onFocus, true);
  addEventListener('blur', onFocus, true);

  const serve = ({ el, block, settle }: BlockHandle): (() => void) => {
    const { title, reads, writes, emits, sizing, interactive, states } = block;
    const say = (why: string): void => console.warn('Custom code "' + title + '": ' + why);
    // One warning a frame, at its first wrong message (or its first reported error), so a frame cannot fill
    // the page's console: every later one is dropped silently.
    let warned = 0;
    const note = (): void => {
      if (!warned++) say('dropped a message or error, then silent');
    };
    // A fifth block: the server draws only four, so this is never run. The address is the server's
    // (boxPath, from the site's id and a stored hash), and the page's enforced frame-src and its per-site
    // <meta> admit only that site's box path, so it is not checked again here.
    if (blocks >= 4) {
      say('not run');
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
    // The frame's messages this second, on its port and to the window alike.
    let second = -Infinity;
    let count = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pinger: ReturnType<typeof setInterval> | undefined;
    const scopeOf = (id: string) => el.closest('[' + stateAttribute(id) + ']');
    const watcher = new MutationObserver((records) => records.forEach((record) => send((record.attributeName as string).slice(9))));
    // Within one viewport of the screen, in any direction.
    const near = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && create(), { rootMargin: '100%' });

    const end = (why?: string): void => {
      if (gone) return;
      gone = true;
      if (why) say(why + ': removed');
      clearTimeout(timer);
      clearInterval(pinger);
      near.disconnect();
      watcher.disconnect();
      removeEventListener('message', onMessage);
      if (port) port.close();
      if (frame) {
        frames.delete(frame);
        frame.remove();
      }
      settle(false);
    };

    const post = (message: Record<string, unknown>): void => {
      if (port) port.postMessage(message);
    };

    /**
     * A declared read's value as its scope shows it, never `text` state. Called only for a read: at
     * `connect` for each, and by an observer whose filter holds only the reads' attributes.
     */
    const send = (id: string): void => {
      const state = states[id];
      const type = state && state.type;
      const scope = scopeOf(id);
      const text = scope && scope.getAttribute(stateAttribute(id));
      const value = type === 'boolean' ? text === 'true' : type === 'number' ? Number(text) : type === 'choice' ? text : null;
      if (text != null && value != null) post({ kind: 'state', id, value });
    };

    /**
     * Counts one message of the frame: true past 30 this second. Past 90 in a second the frame is removed: every
     * message costs the page a task, so a flood ends rather than being dropped message by message.
     */
    const over = (): boolean => {
      if (now() - second > 1000) {
        second = now();
        count = 0;
      }
      if (++count > 90) end('flooded');
      return count > 30;
    };

    /** One message on the port, under every rule of the protocol. */
    const onPort = ({ data }: MessageEvent): void => {
      if (over()) return note();
      // Its size as JSON, when it is plain data: primitives, arrays and plain objects only. A buffer, a typed
      // array, a Map or a Set says nothing as JSON however large it is, so such a message is refused.
      let size = -1;
      try {
        size = new Blob([JSON.stringify(data, plain)]).size;
      } catch {
        // Not plain data.
      }
      // Not plain data after any earlier wrong message (the first is warned of) removes the frame.
      if (size < 0) return warned ? end('not plain data') : note();
      if (size > 65536) return note();
      const kind = data.kind;
      if (kind === 'pong') missed = 0;
      else if (kind === 'setState' && writes.includes(data.id) && fits(states[data.id], data.value)) kit.write(data.id, data.value, el);
      else if (kind === 'emit' && emits.includes(data.name)) kit.emit(data.name.slice(7), el);
      else if (kind === 'resize' && sizing === 'content' && count <= 10 && typeof data.height == 'number' && data.height >= 0) {
        (frame as HTMLIFrameElement).style.height = Math.min(data.height, 10_000) + 'px';
      } else note();
    };

    const onMessage = (event: MessageEvent): void => {
      const data = event.data;
      if (!frame || event.source !== frame.contentWindow) return;
      // Every window message of the frame counts against the same ceiling as its port, before hello and after.
      over();
      if (gone || event.origin !== 'null' || !data || data.fc !== 1 || data.kind !== 'hello') return;
      if (hello) return end('a second hello');
      hello = true;
      clearTimeout(timer);
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
      pinger = setInterval(() => {
        onFocus(true);
        if (missed++ > 2) end('no pong');
        else post({ kind: 'ping' });
      }, 5000);
    };

    const create = (): void => {
      near.disconnect();
      if (frame || gone) return;
      const made = (frame = doc.createElement('iframe'));
      // Constants only, and the sandbox before anything else; the address comes last.
      for (const [name, value] of [['sandbox', 'allow-scripts'], ['referrerpolicy', 'no-referrer'], ['loading', 'lazy'], ['allow', ''], ['title', title]]) {
        made.setAttribute(name, value);
      }
      // Hidden until hello, but laid out at the box's width, so a lazy frame still loads and the page does not widen.
      // A `content` frame starts at 150 pixels until its first resize; the box's own min-height still holds the layout.
      made.style.cssText =
        'border:0;display:block;position:absolute;visibility:hidden;width:' + (el.clientWidth || 300) + 'px;height:' + (sizing === 'fixed' ? '100%' : '150px');
      if (!interactive) {
        made.style.pointerEvents = 'none';
        made.tabIndex = -1;
      }
      made.addEventListener('load', () => {
        if (++loads > 1) return end('loaded twice');
        if (!hello) timer = setTimeout(() => end('no hello'), 5000);
      });
      addEventListener('message', onMessage);
      // A person's move explains the frame having the keyboard: the pointer over it now, or the pointer
      // entering a frame or a Tab in the page within the last second, or within 6 seconds when only a ping
      // saw the move.
      made.addEventListener('pointerover', onKey);
      // Typing in the page within half a second before the move explains nothing, pointer or not: a person
      // stops typing before reaching for a frame, a frame that grabs the keyboard under the pointer does not wait.
      frames.set(made, (late) => {
        if (!interactive) return end('took the keyboard');
        if ((now() - typedAt < 500 || (!made.matches(':hover') && now() - tabAt > (late ? 6000 : 1000))) && ++thefts >= 3) end('took the keyboard 3 times');
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
    removeEventListener('keydown', onKey, true);
    removeEventListener('focus', onFocus, true);
    removeEventListener('blur', onFocus, true);
  };
};
