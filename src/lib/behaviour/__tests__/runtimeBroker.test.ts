// What the runtime lends the custom code broker (Kit.write and Kit.emit, slice C3 of
// docs/plans/2026-11-02-sandboxed-custom-code.md). A frame is not a person: what its
// event reaches runs as a replayed press does, state verbs only. These programs are
// handed straight to startBehaviour, past the parser, which already refuses `navigate`
// and the focus verbs in a `custom:` trigger: the run-time rule must hold on its own.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBehaviour } from '../runtime';
import type { Action } from '../format';
import type { BehaviourProgram, Kit, ProgramEntry } from '../program';

const program = (nodes: Record<string, object>): BehaviourProgram => ({
  nodes: Object.fromEntries(Object.entries(nodes).map(([key, entry]) => [key, [entry] as ProgramEntry[]])),
});

let stops: (() => void)[] = [];
let lent: Kit | undefined;
let brokerStopped = 0;
let verbs: Action[] = [];

function start(nodes: Record<string, object>): Kit {
  lent = undefined;
  stops.push(startBehaviour({
    container: document,
    program: program(nodes),
    surface: 'published',
    verbs: () => (action) => verbs.push(action),
    broker: (kit) => {
      // The page is adopted by now: the state a frame writes is already held.
      expect(document.querySelector('[data-fc-scope]')?.getAttribute('data-fcs-open')).toBe('false');
      lent = kit;
      return () => {
        brokerStopped += 1;
      };
    },
  }));
  if (!lent) throw new Error('the broker was not started');
  return lent;
}

beforeEach(() => {
  stops = [];
  verbs = [];
  brokerStopped = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  document.body.innerHTML = `<div data-fc-n="page" data-fc-scope data-fcs-open="false" data-fcs-n="0">
    <div id="box"><span data-fc-n="input">x</span></div>
  </div>`;
});

afterEach(() => {
  stops.forEach((stop) => stop());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const box = () => document.getElementById('box') as HTMLElement;
const scope = () => document.querySelector('[data-fc-scope]') as HTMLElement;

describe('the kit a broker gets', () => {
  it('writes a state from the nearest scope that holds it, reflected for the frames that read it', () => {
    const kit = start({ page: { state: [{ id: 'open', type: 'boolean', initial: false }, { id: 'n', type: 'number', initial: 0 }] } });
    expect(kit.write('open', true, box())).toBe(true);
    expect(scope().getAttribute('data-fcs-open')).toBe('true');
    expect(kit.write('open', true, box())).toBe(false);
    expect(kit.write('missing', 1, box())).toBe(false);
  });

  it("runs a frame's event as state verbs only: never navigate, a focus verb, or a chain", () => {
    const kit = start({
      page: {
        state: [{ id: 'open', type: 'boolean', initial: false }, { id: 'n', type: 'number', initial: 0 }],
        on: [{ id: 'go', on: 'custom:go', do: [{ navigate: '/elsewhere' }, { focus: 'input' }, { scroll: 'input' }, { emit: 'next' }, { delay: 10, do: [{ toggle: 'open' }] }, { set: 'n', value: 3 }] },
          { id: 'next', on: 'custom:next', do: [{ toggle: 'open' }] }],
      },
    });
    kit.emit('go', box());
    expect(verbs).toEqual([]);
    expect(scope().getAttribute('data-fcs-n')).toBe('3');
    // Neither the emitted chain nor the delayed toggle ran.
    expect(scope().getAttribute('data-fcs-open')).toBe('false');
  });

  it('fires only the named event, up from the box', () => {
    const kit = start({
      page: { state: [{ id: 'open', type: 'boolean', initial: false }], on: [{ id: 'a', on: 'custom:other', do: [{ toggle: 'open' }] }] },
    });
    kit.emit('go', box());
    expect(scope().getAttribute('data-fcs-open')).toBe('false');
    kit.emit('other', box());
    expect(scope().getAttribute('data-fcs-open')).toBe('true');
  });

  it('stops the broker with the runtime', () => {
    start({ page: { state: [{ id: 'open', type: 'boolean', initial: false }] } });
    stops.forEach((stop) => stop());
    stops = [];
    expect(brokerStopped).toBe(1);
  });
});
